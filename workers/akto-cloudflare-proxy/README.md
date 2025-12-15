# Akto Cloudflare Worker Proxy

## Overview

This worker is a **transparent proxy** that intercepts traffic to your Cloudflare Workers and mirrors it to Akto for API discovery and security monitoring.

**Key Features:**
- Supports HTTP/HTTPS and WebSocket traffic
- Non-blocking traffic mirroring using `ctx.waitUntil()`
- Transparent proxying via MCP service binding
- Automatic capture of API requests and responses

**Use Case:** Deploy this worker in front of your existing Cloudflare Worker to automatically send all traffic data to Akto without modifying your original worker code.

## Prerequisites

- Node.js 18+
- Wrangler CLI: `npm install -g wrangler`
- Authenticated with Cloudflare: `wrangler login`
- Target worker deployed (the worker you want to proxy traffic to)
- Akto data ingestion service URL

## Installation

```bash
npm install
```

## Configuration

### Step 1: Configure MCP Service Binding

The MCP (My Cloudflare Proxy) binding connects this proxy to your target worker.

1. Open `wrangler.jsonc`
2. Replace `<YOUR_TARGET_WORKER_NAME>` with your actual worker name:

```jsonc
"services": [
  {
    "binding": "MCP",
    "service": "my-api-worker"  // Replace with your worker name
  }
]
```

**Example:** If your target worker is named `my-api-worker`, set:
```jsonc
"service": "my-api-worker"
```

### Step 2: Configure Data Ingestion URL

The worker sends mirrored traffic to your Akto data ingestion service.

1. Open `src/index.ts`
2. Find the line with `https://<DATA_INGESTION_SERVICE>/api/ingestData`
3. Replace `<DATA_INGESTION_SERVICE>` with your Akto ingestion URL

**Example:**
```javascript
const aktoReq = new Request("https://traffic.domain.com/api/ingestData", {
```

### Optional: Use Service Binding for Data Ingestion

If you're hosting the Akto ingestion service as a Cloudflare worker, you can use a service binding instead:

1. Add a service binding in `wrangler.jsonc`:
```jsonc
"services": [
  {
    "binding": "MCP",
    "service": "my-api-worker"
  },
  {
    "binding": "AKTO_INGESTION",
    "service": "akto-ingest-guardrails"
  }
]
```

2. Update `src/index.ts` to use the binding:
```javascript
// Replace this line:
const aktoResp = await fetch(aktoReq);

// With this:
const aktoResp = await env.AKTO_INGESTION.fetch(aktoReq);
```

## Deployment

Deploy the worker to Cloudflare:

```bash
npm run deploy
```

or

```bash
npx wrangler deploy
```

## Configure Routes

You need to configure routes to direct traffic through this proxy. You can do this in two ways:

### Option 1: Configure in wrangler.jsonc (Recommended)

Update the `routes` section in `wrangler.jsonc`:

```jsonc
"routes": [
  {
    "pattern": "*.yourdomain.com/*",
    "zone_name": "yourdomain.com"
  }
]
```

**Example Route Configurations:**
- `"pattern": "api.yourdomain.com/*"` - Proxy all API subdomain traffic
- `"pattern": "*.yourdomain.com/api/*"` - Proxy all /api paths across subdomains
- `"pattern": "yourdomain.com/*"` - Proxy all traffic for the domain

Then deploy with `npm run deploy` to apply the routes automatically.

### Option 2: Configure via Cloudflare Dashboard

Alternatively, configure routes after deployment:

1. Navigate to [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages**
2. Select your **akto-cloudflare-proxy** worker
3. Go to **Settings** → **Domains & Routes**
4. Click **Add Route**
5. Select your zone (domain) and enter a route pattern (e.g., `*.yourdomain.com/*`)

This ensures all matching traffic is intercepted by the proxy and mirrored to Akto.

## How It Works

1. **Traffic Interception:** Incoming requests matching your route pattern are sent to this proxy worker
2. **Request Forwarding:** The proxy forwards requests to your target worker via the MCP service binding
3. **Traffic Mirroring:** Request and response data are asynchronously sent to Akto (non-blocking)
4. **Response Delivery:** The original response is returned to the client without modification

```
Client → Proxy Worker → Target Worker (via MCP)
           ↓
        Akto Ingestion (async)
```

## Important Notes

- **Deploy Target Worker First:** The MCP binding requires your target worker to be deployed before this proxy
- **Non-Blocking Mirroring:** Traffic mirroring uses `ctx.waitUntil()` so it doesn't slow down responses
- **Selective Logging:** Only successful requests (2xx-3xx status codes) with valid content-types are logged
- **Supported Content Types:** JSON, XML, form-urlencoded, SOAP, GRPC
- **WebSocket Support:** WebSocket connections are proxied and metadata is captured
- **Hardcoded Binding Name:** The MCP binding name is hardcoded in the worker code and must match in `wrangler.jsonc`

## Troubleshooting

### Error: Service not found
**Problem:** The MCP binding can't find your target worker.

**Solution:**
- Verify the target worker name in `wrangler.jsonc` matches exactly
- Ensure your target worker is deployed: `wrangler deployments list`
- Check worker is in the same Cloudflare account

### No traffic appearing in Akto
**Problem:** Data isn't reaching your Akto dashboard.

**Solution:**
- Verify the data ingestion URL in `src/index.ts` is correct
- Check worker logs: `wrangler tail akto-cloudflare-proxy`
- Look for "✅ Log sent to akto" or error messages
- Ensure content-type headers are present in requests/responses

### Service binding error on deployment
**Problem:** Wrangler fails with service binding error.

**Solution:**
- Deploy your target worker first
- Use the exact worker name (case-sensitive)
- Ensure you're in the correct Cloudflare account

### View Worker Logs
Monitor real-time logs to debug issues:

```bash
wrangler tail akto-cloudflare-proxy
```

Look for these log messages:
- 🚀 Worker handling - Request received
- ⬅️ Upstream response - Response from target worker
- ✅ Log sent to akto - Data successfully mirrored
- ❌ Failed to send data - Mirroring error

## Related Documentation

For more information on configuring this worker, see the [full documentation](https://docs.akto.io/traffic-connector/api-gateways/connect-akto-with-cloudflare-worker-proxy).
