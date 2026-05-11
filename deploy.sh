#!/bin/bash
# Akto Cloudflare Deployment Script
#
# Deploys Akto workers to Cloudflare in the correct order.
# Images are already in the Cloudflare registry — no Docker required.
#
#   Option 1  (Ingestion + Guardrails):
#     akto-guardrails-executor  →  akto-ingest-guardrails  →  akto-cloudflare-proxy
#
#   Option 2  (Ingestion only):
#     akto-ingest-guardrails  →  akto-cloudflare-proxy

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
        [ "$v" -lt 18 ] && { err "Node.js v18+ required (found $(node -v))"; fail=1; } \
                        || ok "Node.js $(node -v)"
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

# ─── First-time image push ────────────────────────────────────────────────────
# Cloudflare Containers requires images to be in the Cloudflare registry
# (registry.cloudflare.com/<account-id>/...) before wrangler deploy can succeed.
# This only needs to run once per account. Subsequent deploys skip this entirely.
push_images() {
    local push_executor="$1"  # "true" or "false"

    echo ""
    echo -e "  ${BOLD}First-time setup: pushing container images to Cloudflare registry${NC}"
    echo "  This is a one-time step. Subsequent deploys skip it automatically."
    echo ""

    if ! command -v docker &>/dev/null || ! docker info &>/dev/null 2>&1; then
        err "Docker is required to push images for the first time."
        err "Install Docker from https://docker.com, start it, then re-run this script."
        exit 1
    fi
    ok "Docker available"

    if [ "$push_executor" = "true" ]; then
        echo ""
        echo "  Pushing akto-guardrails-executor image..."
        cd "$REPO_ROOT/workers/akto-guardrails-executor"
        npm install --silent
        docker pull --platform linux/amd64 public.ecr.aws/aktosecurity/akto-agent-guard-executor:1.12.1_local
        docker buildx build --platform linux/amd64 --load -t agent-guard-executor:latest - <<'EOF'
FROM public.ecr.aws/aktosecurity/akto-agent-guard-executor:1.12.1_local
EOF
        npx wrangler containers push agent-guard-executor:latest
        ok "agent-guard-executor pushed"
        cd "$REPO_ROOT"
    fi

    echo ""
    echo "  Pushing akto-ingest-guardrails (MRS) image..."
    cd "$REPO_ROOT/workers/akto-ingest-guardrails"
    npm install --silent
    docker pull --platform linux/amd64 aktosecurity/mini-runtime-service:latest
    docker buildx build --platform linux/amd64 --load -t mrs:latest - <<'EOF'
FROM aktosecurity/mini-runtime-service:latest
EOF
    npx wrangler containers push mrs:latest
    ok "mrs pushed"
    cd "$REPO_ROOT"

    echo ""
    ok "Images pushed. Continuing with worker deployment..."
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
        [ -n "$KV_ID" ] \
            && ok "KV namespace created: $KV_ID — uncomment kv_namespaces in wrangler.jsonc and set id = $KV_ID" \
            || warn "Could not parse KV ID — check Cloudflare Dashboard → Workers KV"
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

  Deployment options:

    1.  Data Ingestion + MCP Guardrails  (recommended)
        Deploys: akto-guardrails-executor → akto-ingest-guardrails → akto-cloudflare-proxy
        Every request is validated against your Akto security policies.

    2.  Data Ingestion Only
        Deploys: akto-ingest-guardrails → akto-cloudflare-proxy
        Traffic is mirrored to Akto for API discovery and monitoring.

BANNER

read -rp "  Option (1 or 2): " DEPLOY_OPTION
case "$DEPLOY_OPTION" in
    1) ENABLE_GUARDRAILS="true"  ;;
    2) ENABLE_GUARDRAILS="false" ;;
    *) err "Enter 1 or 2."; exit 1 ;;
esac
ok "Option ${DEPLOY_OPTION} selected (guardrails: ${ENABLE_GUARDRAILS})"

check_prereqs
ask_cloudflare_account_id
ask_akto_account_id

# First-time check: are images already in the Cloudflare registry?
echo ""
echo -e "  ${BOLD}Is this the first time deploying to this Cloudflare account?${NC}"
echo "  (If yes, container images will be pushed to your Cloudflare registry.)"
echo "  (If no, this step is skipped — images are already there.)"
echo ""
read -rp "  First time? (y/N): " FIRST_TIME
if [[ "$FIRST_TIME" =~ ^[Yy]$ ]]; then
    # Patch account ID into wrangler.jsonc files before pushing, so wrangler knows where to push
    sed -i.bak "s|registry.cloudflare.com/<YOUR_CLOUDFLARE_ACCOUNT_ID>/|registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/|g" \
        "$REPO_ROOT/workers/akto-ingest-guardrails/wrangler.jsonc"
    rm -f "$REPO_ROOT/workers/akto-ingest-guardrails/wrangler.jsonc.bak"
    if [ "$DEPLOY_OPTION" = "1" ]; then
        sed -i.bak "s|registry.cloudflare.com/<YOUR_CLOUDFLARE_ACCOUNT_ID>/|registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/|g" \
            "$REPO_ROOT/workers/akto-guardrails-executor/wrangler.jsonc"
        rm -f "$REPO_ROOT/workers/akto-guardrails-executor/wrangler.jsonc.bak"
        push_images "true"
    else
        push_images "false"
    fi
fi

if [ "$DEPLOY_OPTION" = "1" ]; then
    deploy_guardrails_executor
    deploy_ingest_guardrails "Step 2/3"
    deploy_proxy "Step 3/3"
else
    deploy_ingest_guardrails "Step 1/2"
    deploy_proxy "Step 2/2"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
header "Deployment Complete"

echo -e "  ${GREEN}${BOLD}No changes required to your existing worker or origin server.${NC}"
echo "  The proxy intercepts traffic via the Cloudflare route rule you configured."
echo ""

if [ "$DEPLOY_OPTION" = "1" ]; then
    echo "  Traffic flow:"
    echo ""
    echo "    Client"
    echo "      → akto-cloudflare-proxy  (validates request via guardrails)"
    echo "      → your existing worker / origin  ← no code changes needed"
    echo "      ← akto-cloudflare-proxy  (streams response to client)"
    echo "      ⤷ akto-ingest-guardrails (async: logs traffic → MRS container → Akto)"
else
    echo "  Traffic flow:"
    echo ""
    echo "    Client"
    echo "      → akto-cloudflare-proxy  (transparent proxy)"
    echo "      → your existing worker / origin  ← no code changes needed"
    echo "      ← akto-cloudflare-proxy  (streams response to client)"
    echo "      ⤷ akto-ingest-guardrails (async: logs traffic → MRS container → Akto)"
fi

echo ""
echo "  Tail logs:"
echo "    npx wrangler tail akto-cloudflare-proxy    --format pretty"
echo "    npx wrangler tail akto-ingest-guardrails   --format pretty"
[ "$DEPLOY_OPTION" = "1" ] && \
echo "    npx wrangler tail akto-guardrails-executor --format pretty"

echo ""
echo -e "${GREEN}${BOLD}  Done. Check Akto Dashboard → API Collections to verify traffic.${NC}"
echo ""
