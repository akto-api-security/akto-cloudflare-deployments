# Capturing Traffic on a Specific Path

Use this guide when your MCP server is already serving multiple teams on a shared URL (e.g., `https://sandbox.example.com/mcp`) and you only want Akto to capture traffic on a **new, dedicated path** — leaving the existing `/mcp` path untouched.

---

## Option A — Add a new path (recommended)

This is a two-step process: expose the new path, then point Akto's route rule at only that path.

### Step 1 — Add the new path on your MCP server

Register the new path (e.g., `/mcp-akto`) on your server so it handles requests identically to `/mcp`. Example in Express / Node.js:

```js
// existing
app.use('/mcp', mcpHandler);

// add the new Akto-monitored path — same handler
app.use('/mcp-akto', mcpHandler);
```

Teams that should not be monitored continue using `https://sandbox.example.com/mcp`. Teams whose traffic should flow through Akto switch to `https://sandbox.example.com/mcp-akto`.

---

### Step 2 — Point Akto's route rule at the new path only

In your `.env`, set `ROUTE_PATTERN` to the new path:

```bash
ROUTE_PATTERN=sandbox.example.com/mcp-akto*
```

The `*` wildcard ensures all sub-paths (e.g., `/mcp-akto/sse`, `/mcp-akto/messages`) are also captured.

Then redeploy only the proxy worker:

```bash
cd workers/akto-cloudflare-proxy
npx wrangler deploy
```

Or re-run the full `./deploy.sh` — it is safe to run multiple times.

---

### How this works

```
Client → https://sandbox.example.com/mcp         → your origin (Akto never sees this)
Client → https://sandbox.example.com/mcp-akto    → akto-cloudflare-proxy-cf → your origin
                                                          ↳ async: ingest + guardrails
```

Cloudflare only routes requests matching the route rule to the proxy worker. Requests to `/mcp` bypass it entirely — Akto receives zero traffic from those requests.

---

## Option B — Full new installation

If neither server changes nor path rewriting are feasible, deploy a completely separate Akto instance:

1. Follow the standard [deployment instructions](../README.md).
2. Use a `ROUTE_PATTERN` that matches only the traffic you want Akto to see — for example, a subdomain you control:
   ```bash
   ROUTE_PATTERN=akto-mcp.yourdomain.com/*
   ```
3. Configure your MCP clients to point at the new subdomain instead of the shared URL.

This approach gives full isolation: the Akto-monitored endpoint is a separate Cloudflare worker with its own route, completely independent of the shared MCP server.
