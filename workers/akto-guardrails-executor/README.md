# Akto Guardrails Executor Worker - Deployment

## Prerequisites

- Docker with buildx
- Node.js 18+
- Wrangler CLI: `npm install -g wrangler`
- Authenticated: `wrangler login`

## Deployment Steps

### 1. Install Dependencies

```bash
npm install
```

### 2. Push Container Image to Cloudflare Registry

```bash
# Pull base image
docker pull --platform linux/amd64 public.ecr.aws/aktosecurity/akto-guardrail-executor:1.12.1_local

# Rebuild for linux/amd64 (required)
docker buildx build --platform linux/amd64 --load -t guardrail-executor:testing - <<'EOF'
FROM public.ecr.aws/aktosecurity/akto-guardrail-executor:1.12.1_local
EOF

# Push to Cloudflare
npx wrangler containers push guardrail-executor:testing
```

### 3. Update wrangler.jsonc

Set the image path (replace with your Cloudflare account ID):
```jsonc
"image": "registry.cloudflare.com/<YOUR_CLOUDFLARE_ACCOUNT_ID>/guardrail-executor:testing"
```

### 4. Deploy

```bash
npx wrangler deploy
```
