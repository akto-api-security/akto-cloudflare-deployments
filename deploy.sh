#!/bin/bash
# Akto Cloudflare Deployment Script
#
# Deploys the full Akto stack to Cloudflare in the correct order:
# - Pulls pre-built Docker images for mini-runtime and data-ingestion-service
# - Deploys workers with guardrails validation and API discovery
#
# Flow: Client → akto-cloudflare-proxy → akto-ingest-guardrails/guardrails-executor
#       → origin server → async: data-ingestion-service → mini-runtime → Akto

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

header() { echo ""; echo -e "${BOLD}${BLUE}══════════════════════════════════════════${NC}";
           echo -e "${BOLD}${BLUE}  $1${NC}";
           echo -e "${BOLD}${BLUE}══════════════════════════════════════════${NC}"; echo ""; }
ok()     { echo -e "${GREEN}  ✓${NC}  $1"; }
warn()   { echo -e "${YELLOW}  !${NC}  $1"; }
err()    { echo -e "${RED}  ✗${NC}  $1"; }
step()   { echo -e "\n${BOLD}  [$1]${NC}  $2"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Prerequisites ────────────────────────────────────────────────────────────
check_prereqs() {
    header "Checking Prerequisites"
    local fail=0

    if ! command -v node &>/dev/null; then
        err "Node.js not found — install v18+ from https://nodejs.org"; fail=1
    else
        local v; v=$(node -v | sed 's/v//' | cut -d. -f1)
        if [ "$v" -lt 18 ]; then
            err "Node.js v18+ required (found $(node -v))"; fail=1
        else
            ok "Node.js $(node -v)"
        fi
    fi

    if ! npx wrangler whoami &>/dev/null 2>&1; then
        warn "Not logged in to Cloudflare — running 'wrangler login'..."
        npx wrangler login
    else
        local acct; acct=$(npx wrangler whoami 2>&1 | grep -i "account" | head -1 || true)
        ok "Wrangler authenticated: $acct"
    fi

    if [ "$fail" -eq 1 ]; then
        echo ""; err "Fix the issues above and re-run."; exit 1
    fi
}

# ─── First-time Java service builds + image push ──────────────────────────────
# Pulls pre-built Docker images and pushes them to Cloudflare registry.
push_java_images() {
    echo ""
    echo -e "  ${BOLD}Pulling and pushing Java service Docker images${NC}"
    echo ""

    if ! command -v docker &>/dev/null || ! docker info &>/dev/null 2>&1; then
        err "Docker is required to push images."
        err "Install Docker from https://docker.com, start it, then re-run this script."
        exit 1
    fi
    ok "Docker available"

    step "1" "Pulling mini-runtime from Docker Hub"
    docker pull --platform linux/amd64 aktosecurity/mini-runtime:local
    ok "mini-runtime pulled"

    step "2" "Pushing mini-runtime to Cloudflare registry"
    docker tag aktosecurity/mini-runtime:local "registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/mini-runtime:v1"
    npx wrangler containers push "registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/mini-runtime:v1"
    ok "mini-runtime pushed to Cloudflare registry"

    step "3" "Pulling data-ingestion-service from Docker Hub"
    docker pull --platform linux/amd64 aktosecurity/data-ingestion-service:latest
    ok "data-ingestion-service pulled"

    step "4" "Pushing data-ingestion-service to Cloudflare registry"
    docker tag aktosecurity/data-ingestion-service:latest "registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/data-ingestion-service:v1"
    npx wrangler containers push "registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/data-ingestion-service:v1"
    ok "data-ingestion-service pushed to Cloudflare registry"

    cd "$REPO_ROOT"
    echo ""
    ok "Java service images pushed to Cloudflare registry"
}

# ─── First-time Worker image push ─────────────────────────────────────────────
# Pushes Cloudflare Worker container images (MRS, executor).
push_worker_images() {
    local push_executor="$1"  # "true" or "false"

    echo ""
    echo -e "  ${BOLD}Pushing Cloudflare Worker container images${NC}"
    echo ""

    if [ "$push_executor" = "true" ]; then
        echo "  Pushing akto-guardrails-executor image..."
        cd "$REPO_ROOT/workers/akto-guardrails-executor"
        npm install --silent
        docker pull --platform linux/amd64 aktosecurity/akto-agent-guard-executor:local
        docker buildx build --platform linux/amd64 --load -t agent-guard-executor:v1 - <<'EOF'
FROM aktosecurity/akto-agent-guard-executor:local
EOF
        npx wrangler containers push agent-guard-executor:v1
        ok "agent-guard-executor pushed"
        cd "$REPO_ROOT"
    fi

    echo ""
    echo "  Pushing akto-ingest-guardrails (MRS) image..."
    cd "$REPO_ROOT/workers/akto-ingest-guardrails"
    npm install --silent
    docker pull --platform linux/amd64 aktosecurity/mini-runtime-service:latest
    docker buildx build --platform linux/amd64 --load -t mrs:v1 - <<'EOF'
FROM aktosecurity/mini-runtime-service:latest
EOF
    npx wrangler containers push mrs:v1
    ok "mrs pushed"
    cd "$REPO_ROOT"

    echo ""
    ok "Worker images pushed to Cloudflare registry"
}

# ─── Prompts ──────────────────────────────────────────────────────────────────
ask_cloudflare_account_id() {
    echo ""
    echo -e "${BOLD}  Cloudflare Account ID${NC}"
    echo "  ↳ https://dash.cloudflare.com → your account → Overview (right sidebar)"
    read -rp "  Account ID: " CLOUDFLARE_ACCOUNT_ID
    [ -z "$CLOUDFLARE_ACCOUNT_ID" ] && { err "Cannot be empty."; exit 1; }
    ok "Cloudflare Account ID: $CLOUDFLARE_ACCOUNT_ID"
}

ask_akto_account_id() {
    echo ""
    echo -e "${BOLD}  Akto Account ID${NC}"
    echo "  ↳ Akto Dashboard → Settings → Account  (default: 1000000)"
    read -rp "  Akto Account ID [1000000]: " AKTO_ACCOUNT_ID
    AKTO_ACCOUNT_ID="${AKTO_ACCOUNT_ID:-1000000}"
    ok "Akto Account ID: $AKTO_ACCOUNT_ID"
}

# ─── Workers ──────────────────────────────────────────────────────────────────
deploy_guardrails_executor() {
    header "Step 1/3 — akto-guardrails-executor"
    cd "$REPO_ROOT/workers/akto-guardrails-executor"

    step "1" "Installing dependencies"
    npm install --silent; ok "Done"

    step "2" "Patching wrangler.jsonc with Cloudflare account ID"
    sed -i.bak "s|registry.cloudflare.com/<YOUR_CLOUDFLARE_ACCOUNT_ID>/|registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/|g" wrangler.jsonc
    rm -f wrangler.jsonc.bak; ok "Image registry: registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/..."

    step "3" "Deploying"
    npx wrangler deploy; ok "akto-guardrails-executor deployed ✓"
    cd "$REPO_ROOT"
}

deploy_ingest_guardrails() {
    local step_prefix="$1"
    header "${step_prefix} — akto-ingest-guardrails"
    cd "$REPO_ROOT/workers/akto-ingest-guardrails"

    step "1" "Installing dependencies"
    npm install --silent; ok "Done"

    step "2" "Patching wrangler.jsonc"
    sed -i.bak "s|registry.cloudflare.com/<YOUR_CLOUDFLARE_ACCOUNT_ID>/|registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/|g" wrangler.jsonc
    sed -i.bak "s|\"ENABLE_MCP_GUARDRAILS\": \"[^\"]*\"|\"ENABLE_MCP_GUARDRAILS\": \"${ENABLE_GUARDRAILS}\"|g" wrangler.jsonc
    rm -f wrangler.jsonc.bak
    ok "Image registry: registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/...  ENABLE_MCP_GUARDRAILS=${ENABLE_GUARDRAILS}"

    step "3" "KV namespace for rate limiting (optional)"
    echo ""; read -rp "  Set up KV namespace for rate limiting? (y/N): " SETUP_KV
    if [[ "$SETUP_KV" =~ ^[Yy]$ ]]; then
        KV_OUT=$(npx wrangler kv namespace create "AKTO_GUARDRAILS_RATE_LIMIT_KV" 2>&1 || true)
        KV_ID=$(echo "$KV_OUT" | grep -oE '"id": "[^"]+"' | head -1 | grep -oE '"[^"]+"$' | tr -d '"' || true)
        if [ -n "$KV_ID" ]; then
            ok "KV namespace created: $KV_ID — uncomment kv_namespaces in wrangler.jsonc and set id = $KV_ID"
        else
            warn "Could not parse KV ID — check Cloudflare Dashboard → Workers KV"
        fi
    else
        warn "Skipping KV — rate limiting disabled"
    fi

    step "4" "Setting secrets"
    echo ""
    echo "  Enter your Akto API token"
    echo "  ↳ Akto Dashboard → Quick Start → Hybrid SaaS → Connect → Copy Token"
    echo ""
    npx wrangler secret put DATABASE_ABSTRACTOR_SERVICE_TOKEN; ok "DATABASE_ABSTRACTOR_SERVICE_TOKEN set"
    npx wrangler secret put THREAT_BACKEND_TOKEN;               ok "THREAT_BACKEND_TOKEN set"

    step "5" "Deploying"
    npx wrangler deploy; ok "akto-ingest-guardrails deployed ✓"
    cd "$REPO_ROOT"
}

deploy_proxy() {
    local step_prefix="$1"
    header "${step_prefix} — akto-cloudflare-proxy"
    cd "$REPO_ROOT/workers/akto-cloudflare-proxy"

    step "1" "Installing dependencies"
    npm install --silent; ok "Done"

    step "2" "Configure route"
    echo ""
    echo -e "  ${BOLD}Route pattern${NC} — the Cloudflare route this proxy intercepts."
    echo "  Examples:  api.yourdomain.com/*   or   *.yourdomain.com/*"
    echo "  The domain must already be active in your Cloudflare account."
    echo ""
    read -rp "  Route pattern: " ROUTE_PATTERN
    if [ -n "$ROUTE_PATTERN" ]; then
        ZONE=$(echo "$ROUTE_PATTERN" | sed 's/^\*\.//' | sed 's|/.*||' | awk -F. 'NF>=2{print $(NF-1)"."$NF}')
        sed -i.bak "s|\"pattern\": \"\*\.yourdomain\.com/\*\"|\"pattern\": \"${ROUTE_PATTERN}\"|g" wrangler.jsonc
        sed -i.bak "s|\"zone_name\": \"yourdomain\.com\"|\"zone_name\": \"${ZONE}\"|g" wrangler.jsonc
        rm -f wrangler.jsonc.bak
        ok "Route: ${ROUTE_PATTERN}  (zone: ${ZONE})"
    else
        warn "No route set — configure routes in wrangler.jsonc before going live"
    fi

    step "3" "Patching env vars"
    sed -i.bak "s|\"APPLY_AKTO_GUARDRAILS\": \"[^\"]*\"|\"APPLY_AKTO_GUARDRAILS\": \"${ENABLE_GUARDRAILS}\"|g" wrangler.jsonc
    sed -i.bak "s|\"AKTO_ACCOUNT_ID\": \"[^\"]*\"|\"AKTO_ACCOUNT_ID\": \"${AKTO_ACCOUNT_ID}\"|g" wrangler.jsonc
    rm -f wrangler.jsonc.bak
    ok "APPLY_AKTO_GUARDRAILS=${ENABLE_GUARDRAILS}  AKTO_ACCOUNT_ID=${AKTO_ACCOUNT_ID}"

    step "4" "Deploying"
    npx wrangler deploy; ok "akto-cloudflare-proxy deployed ✓"
    cd "$REPO_ROOT"
}

# ─── Main ─────────────────────────────────────────────────────────────────────
header "Akto  ×  Cloudflare  —  Deployment"

cat <<'BANNER'
  Intercept, analyse, and protect API traffic on Cloudflare Workers.

  Deploying: Full Stack with Guardrails + Discovery
    - mini-runtime → data-ingestion-service → akto-guardrails-executor
    - akto-ingest-guardrails → akto-cloudflare-proxy

  Every request is validated against your Akto security policies.

BANNER

DEPLOY_OPTION="1"
ENABLE_GUARDRAILS="true"
ok "Deploying full stack with guardrails and discovery"

check_prereqs
ask_cloudflare_account_id
ask_akto_account_id

# First-time check: are images already in the Cloudflare registry?
echo ""
echo -e "  ${BOLD}Push Docker images to Cloudflare registry?${NC}"
echo "  (If yes, pre-built images will be pulled and pushed.)"
echo "  (If no, this step is skipped — images are already there.)"
echo ""
read -rp "  Push images? (y/N): " PUSH_IMAGES
if [[ "$PUSH_IMAGES" =~ ^[Yy]$ ]]; then
    # Patch account ID into wrangler.jsonc files before pushing
    sed -i.bak "s|registry.cloudflare.com/<YOUR_CLOUDFLARE_ACCOUNT_ID>/|registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/|g" \
        "$REPO_ROOT/workers/akto-ingest-guardrails/wrangler.jsonc"
    rm -f "$REPO_ROOT/workers/akto-ingest-guardrails/wrangler.jsonc.bak"
    sed -i.bak "s|registry.cloudflare.com/<YOUR_CLOUDFLARE_ACCOUNT_ID>/|registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/|g" \
        "$REPO_ROOT/workers/akto-guardrails-executor/wrangler.jsonc"
    rm -f "$REPO_ROOT/workers/akto-guardrails-executor/wrangler.jsonc.bak"

    # Pull and push Docker images
    push_java_images
    push_worker_images "true"
fi

# Deploy workers
deploy_guardrails_executor
deploy_ingest_guardrails "Step 2/3"
deploy_proxy "Step 3/3"

# ─── Summary ──────────────────────────────────────────────────────────────────
header "Deployment Complete"

echo -e "  ${GREEN}${BOLD}✓ All services deployed successfully!${NC}"
echo ""
echo "  Traffic flow:"
echo ""
echo "    Client request"
echo "      → Cloudflare Network"
echo "      → akto-cloudflare-proxy (route rule)"
echo "      → validates request via akto-ingest-guardrails/guardrails-executor"
echo "      → forwards to your origin server"
echo "      ← response to client"
echo "      ⤷ async: logs traffic → data-ingestion-service → mini-runtime → Akto"

echo ""
echo "  Next steps:"
echo "    1. Verify Cloudflare route is active: dash.cloudflare.com → Workers & Pages → Routes"
echo "    2. Send test traffic to your protected domain"
echo "    3. Check Akto Dashboard → API Collections for discovered APIs"
echo "    4. Check Akto Dashboard → Security Policies for guardrails status"

echo ""
echo "  Monitor logs:"
echo "    npx wrangler tail akto-cloudflare-proxy    --format pretty"
echo "    npx wrangler tail akto-ingest-guardrails   --format pretty"
echo "    npx wrangler tail akto-guardrails-executor --format pretty"

echo ""
echo -e "${GREEN}${BOLD}  Documentation: https://docs.akto.io/traffic-connector/api-gateways/cloudflare${NC}"
echo ""
