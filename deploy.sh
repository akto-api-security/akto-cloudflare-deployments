#!/bin/bash
# Akto Cloudflare Deployment Script
#
# Deploys the full Akto stack to Cloudflare in the correct order.
# Copy .env.example → .env, fill in values, then run ./deploy.sh
#
# Workers deployed:
#   1. akto-mini-runtime          — mini-runtime container (processes & sends to Akto)
#   2. akto-guardrail-executor           — guardrail-executor container (Python scanner)
#   3. akto-guardrails-executor   — guardrails-service container (policy enforcement)
#   4. akto-ingest-guardrails     — data-ingestion-service container (receives traffic)
#   5. akto-cloudflare-proxy      — route worker (intercepts client traffic)
#
# Service bindings (worker → worker, no HTTP):
#   akto-cloudflare-proxy    → akto-ingest-guardrails     (AKTO_INGESTION_WORKER)
#   akto-ingest-guardrails   → akto-guardrails-executor   (AKTO_GUARDRAILS_EXECUTOR)
#   akto-ingest-guardrails   → akto-mini-runtime          (AKTO_MINI_RUNTIME_WORKER)
#
# External service (not deployed here):
#   AGENT_GUARD_ENGINE_URL — set in akto-guardrails-executor/wrangler.jsonc

set -eo pipefail

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

# ─── Load .env ────────────────────────────────────────────────────────────────
ENV_FILE="$REPO_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; source "$ENV_FILE"; set +a
    ok "Loaded .env"
else
    warn ".env not found — copy .env.example → .env and fill in values."
    warn "Falling back to interactive prompts."
fi

# ─── Container runtime detection ─────────────────────────────────────────────
# Prefer podman; fall back to docker.
# When using podman, DOCKER_HOST is pointed at podman's Docker-compatible socket
# so that `wrangler containers push` (which speaks the Docker API) can find
# images in podman's local store.
if command -v podman &>/dev/null && podman info &>/dev/null 2>&1; then
    CONTAINER_CLI=podman
    # Resolve podman socket: explicit env var wins, then podman machine (macOS),
    # then the standard systemd user socket (Linux).
    if [ -z "$DOCKER_HOST" ]; then
        _podman_sock=""
        if command -v podman &>/dev/null; then
            _podman_sock=$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}' 2>/dev/null | head -1 || true)
        fi
        if [ -z "$_podman_sock" ]; then
            _podman_sock="/run/user/$(id -u)/podman/podman.sock"
        fi
        if [ -S "$_podman_sock" ]; then
            export DOCKER_HOST="unix://$_podman_sock"
        else
            warn "Podman socket not found at $_podman_sock — 'wrangler containers push' may fail."
            warn "Start it with: systemctl --user start podman.socket  (Linux)"
            warn "           or: podman machine start                  (macOS)"
        fi
    fi
elif command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    CONTAINER_CLI=docker
else
    CONTAINER_CLI=""
fi

# ─── Container image helpers ──────────────────────────────────────────────────
# When using docker, a "docker-container" driver buildx builder is required to
# correctly embed linux/amd64 platform metadata that wrangler validates.
# Podman's native builder handles --platform correctly without a custom driver.
_ensure_buildx_builder() {
    if ! docker buildx inspect akto-cf-builder &>/dev/null 2>&1; then
        docker buildx create --name akto-cf-builder \
            --driver docker-container --bootstrap
    fi
}

_push_cf_image() {
    local src="$1"   # source image (already pulled locally)
    local dst="$2"   # destination: registry.cloudflare.com/ACCOUNT/name:tag

    if [ "$CONTAINER_CLI" = "podman" ]; then
        echo "FROM $src" | \
            podman build \
                --platform linux/amd64 \
                --format docker \
                -t "$dst" \
                -
    else
        _ensure_buildx_builder
        echo "FROM $src" | \
            docker buildx build \
                --builder akto-cf-builder \
                --platform linux/amd64 \
                --provenance=false \
                --load \
                -t "$dst" \
                -
    fi

    npx wrangler containers push "$dst"
}

# ─── Patch registry URL (idempotent) ─────────────────────────────────────────
_patch_registry() {
    local file="$1"
    sed -i.bak \
        "s|registry.cloudflare.com/[^/]*/|registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/|g" \
        "$file"
    rm -f "${file}.bak"
}

# ─── Set wrangler secret non-interactively when value is available ─────────────
_set_secret() {
    local key="$1"
    local value="$2"
    local prompt="$3"

    if [ -n "$value" ]; then
        printf '%s' "$value" | npx wrangler secret put "$key"
        ok "${key} set"
    else
        warn "${key} not set in .env — enter it now (or press Ctrl+C to abort):"
        echo "  ↳ ${prompt}"
        npx wrangler secret put "$key"
        ok "${key} set"
    fi
}

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

    if [ -n "$CLOUDFLARE_API_TOKEN" ]; then
        ok "Wrangler auth: CLOUDFLARE_API_TOKEN is set"
    elif ! npx wrangler whoami &>/dev/null 2>&1; then
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

# ─── Prompts (only used as fallback when .env values are missing) ─────────────
_require_cloudflare_account_id() {
    if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
        echo ""
        echo -e "${BOLD}  Cloudflare Account ID${NC}"
        echo "  ↳ https://dash.cloudflare.com → your account → Overview (right sidebar)"
        read -rp "  Account ID: " CLOUDFLARE_ACCOUNT_ID
        [ -z "$CLOUDFLARE_ACCOUNT_ID" ] && { err "Cannot be empty."; exit 1; }
    fi
    export CLOUDFLARE_ACCOUNT_ID
    ok "Cloudflare Account ID: $CLOUDFLARE_ACCOUNT_ID"
}

_require_akto_account_id() {
    if [ -z "$AKTO_ACCOUNT_ID" ]; then
        echo ""
        echo -e "${BOLD}  Akto Account ID${NC}"
        echo "  ↳ Akto Dashboard → Settings → Account  (default: 1000000)"
        read -rp "  Akto Account ID [1000000]: " AKTO_ACCOUNT_ID
        AKTO_ACCOUNT_ID="${AKTO_ACCOUNT_ID:-1000000}"
    fi
    ok "Akto Account ID: $AKTO_ACCOUNT_ID"
}

_require_image_tag() {
    if [ -z "$IMAGE_TAG" ]; then
        echo ""
        echo -e "${BOLD}  Image version tag${NC}"
        echo "  Version tag for images pushed to Cloudflare registry (e.g. v1, v2, ...)."
        read -rp "  Image tag [v1]: " IMAGE_TAG
        IMAGE_TAG="${IMAGE_TAG:-v1}"
    fi
    ok "Image tag: ${IMAGE_TAG}"
}

_require_route_pattern() {
    : # ROUTE_PATTERN is optional — empty means no route is configured
}

# ─── Image push ───────────────────────────────────────────────────────────────
push_images() {
    if [ -z "$CONTAINER_CLI" ]; then
        err "No container runtime found — install podman (preferred) or docker, start it, then re-run."
        err "  Podman: https://podman.io/docs/installation"
        err "  Docker: https://docker.com"
        exit 1
    fi
    ok "Container runtime: $CONTAINER_CLI"

    echo ""
    echo -e "  ${BOLD}Pushing images to Cloudflare registry (tag: ${IMAGE_TAG})${NC}"
    echo ""

    step "1" "mini-runtime"
    $CONTAINER_CLI pull --platform linux/amd64 docker.io/aktosecurity/mini-runtime:local
    _push_cf_image \
        "docker.io/aktosecurity/mini-runtime:local" \
        "registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/mini-runtime:${IMAGE_TAG}"
    ok "mini-runtime:${IMAGE_TAG} pushed"

    step "2" "data-ingestion-service"
    $CONTAINER_CLI pull --platform linux/amd64 docker.io/aktosecurity/data-ingestion-service:latest
    _push_cf_image \
        "docker.io/aktosecurity/data-ingestion-service:latest" \
        "registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/data-ingestion-service:${IMAGE_TAG}"
    ok "data-ingestion-service:${IMAGE_TAG} pushed"

    step "3" "guardrails-service"
    $CONTAINER_CLI pull --platform linux/amd64 docker.io/aktosecurity/akto-guardrails-service:local
    _push_cf_image \
        "docker.io/aktosecurity/akto-guardrails-service:local" \
        "registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/guardrails-service:${IMAGE_TAG}"
    ok "guardrails-service:${IMAGE_TAG} pushed"

    step "4" "agent-guard-executor (Python scanner)"
    $CONTAINER_CLI pull --platform linux/amd64 docker.io/aktosecurity/akto-agent-guard-executor:local
    _push_cf_image \
        "docker.io/aktosecurity/akto-agent-guard-executor:local" \
        "registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/guardrail-executor:${IMAGE_TAG}"
    ok "guardrail-executor:${IMAGE_TAG} pushed"

    echo ""
    ok "All images pushed to Cloudflare registry"
}

# ─── Workers ──────────────────────────────────────────────────────────────────
deploy_mini_runtime() {
    header "Step 1/5 — akto-mini-runtime"
    cd "$REPO_ROOT/workers/akto-mini-runtime"

    step "1" "Installing dependencies"
    npm install --silent; ok "Done"

    step "2" "Patching wrangler.jsonc"
    _patch_registry wrangler.jsonc
    ok "Image registry: registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/..."

    step "3" "Setting secrets"
    _set_secret "DATABASE_ABSTRACTOR_SERVICE_TOKEN" "$AKTO_API_TOKEN" \
        "Akto Dashboard → Quick Start → Hybrid SaaS → Connect → Copy Token"

    step "4" "Deploying"
    npx wrangler deploy; ok "akto-mini-runtime deployed ✓"
    cd "$REPO_ROOT"
}

deploy_agent_guard_executor() {
    header "Step 2/5 — akto-guardrail-executor"
    cd "$REPO_ROOT/workers/akto-guardrail-executor"

    step "1" "Installing dependencies"
    npm install --silent; ok "Done"

    step "2" "Patching wrangler.jsonc"
    _patch_registry wrangler.jsonc
    ok "Image registry: registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/..."

    step "3" "Deploying"
    local deploy_out deploy_tmp
    deploy_tmp=$(mktemp)
    npx wrangler deploy 2>&1 | tee "$deploy_tmp"
    deploy_out=$(cat "$deploy_tmp"); rm -f "$deploy_tmp"
    AGENT_GUARD_URL=$(echo "$deploy_out" | grep -o 'https://akto-guardrail-executor\.[^ ]*' | head -1)
    if [ -n "$AGENT_GUARD_URL" ]; then
        ok "akto-guardrail-executor deployed ✓ → ${AGENT_GUARD_URL}"
    else
        ok "akto-guardrail-executor deployed ✓"
    fi
    cd "$REPO_ROOT"
}

deploy_guardrails_executor() {
    header "Step 3/5 — akto-guardrails-executor"
    cd "$REPO_ROOT/workers/akto-guardrails-executor"

    step "1" "Installing dependencies"
    npm install --silent; ok "Done"

    step "2" "Patching wrangler.jsonc"
    _patch_registry wrangler.jsonc
    if [ -n "$AGENT_GUARD_URL" ]; then
        sed -i.bak \
            -e "s|\"AGENT_GUARD_ENGINE_URL\": \"[^\"]*\"|\"AGENT_GUARD_ENGINE_URL\": \"${AGENT_GUARD_URL}\"|g" \
            wrangler.jsonc
        rm -f wrangler.jsonc.bak
        ok "AGENT_GUARD_ENGINE_URL=${AGENT_GUARD_URL}"
    else
        warn "AGENT_GUARD_URL not detected — AGENT_GUARD_ENGINE_URL left empty"
    fi

    step "3" "Setting secrets"
    _set_secret "DATABASE_ABSTRACTOR_SERVICE_TOKEN" "$AKTO_API_TOKEN" \
        "Akto Dashboard → Quick Start → Hybrid SaaS → Connect → Copy Token"

    step "4" "Deploying"
    npx wrangler deploy; ok "akto-guardrails-executor deployed ✓"
    cd "$REPO_ROOT"
}

deploy_ingest_guardrails() {
    header "Step 4/5 — akto-ingest-guardrails"
    cd "$REPO_ROOT/workers/akto-ingest-guardrails"

    step "1" "Installing dependencies"
    npm install --silent; ok "Done"

    step "2" "Patching wrangler.jsonc"
    _patch_registry wrangler.jsonc
    sed -i.bak \
        -e "s|\"ENABLE_MCP_GUARDRAILS\": \"[^\"]*\"|\"ENABLE_MCP_GUARDRAILS\": \"true\"|g" \
        wrangler.jsonc
    rm -f wrangler.jsonc.bak
    ok "ENABLE_MCP_GUARDRAILS=true"

    step "3" "Deploying"
    npx wrangler deploy; ok "akto-ingest-guardrails deployed ✓"
    cd "$REPO_ROOT"
}

deploy_proxy() {
    header "Step 5/5 — akto-cloudflare-proxy"
    cd "$REPO_ROOT/workers/akto-cloudflare-proxy"

    step "1" "Installing dependencies"
    npm install --silent; ok "Done"

    step "2" "Patching wrangler.jsonc"
    if [ -n "$ROUTE_PATTERN" ]; then
        ZONE=$(echo "$ROUTE_PATTERN" | sed 's/^\*\.//' | sed 's|/.*||' | awk -F. 'NF>=2{print $(NF-1)"."$NF}')
        sed -i.bak \
            -e "s|\"pattern\": \"[^\"]*\"|\"pattern\": \"${ROUTE_PATTERN}\"|g" \
            -e "s|\"zone_name\": \"[^\"]*\"|\"zone_name\": \"${ZONE}\"|g" \
            wrangler.jsonc
        rm -f wrangler.jsonc.bak
        ok "Route: ${ROUTE_PATTERN}  (zone: ${ZONE})"
    else
        # Remove the routes block so wrangler deploys without binding to any route.
        # The worker can still be invoked directly or via a custom domain binding.
        node -e "
            const fs = require('fs');
            const src = fs.readFileSync('wrangler.jsonc', 'utf8');
            // Strip the entire \"routes\": [...] block (handles multi-line, with comments)
            const out = src.replace(/,?\s*\"routes\"\s*:\s*\[[^\]]*\]/s, '');
            fs.writeFileSync('wrangler.jsonc', out);
        "
        ok "ROUTE_PATTERN not set — routes block removed, worker deployed without a route"
    fi

    GUARDRAILS_MODE="${GUARDRAILS_MODE:-async}"
    sed -i.bak \
        -e "s|\"APPLY_AKTO_GUARDRAILS\": \"[^\"]*\"|\"APPLY_AKTO_GUARDRAILS\": \"true\"|g" \
        -e "s|\"AKTO_GUARDRAILS_MODE\": \"[^\"]*\"|\"AKTO_GUARDRAILS_MODE\": \"${GUARDRAILS_MODE}\"|g" \
        -e "s|\"AKTO_ACCOUNT_ID\": \"[^\"]*\"|\"AKTO_ACCOUNT_ID\": \"${AKTO_ACCOUNT_ID}\"|g" \
        wrangler.jsonc
    rm -f wrangler.jsonc.bak
    ok "APPLY_AKTO_GUARDRAILS=true  AKTO_GUARDRAILS_MODE=${GUARDRAILS_MODE}  AKTO_ACCOUNT_ID=${AKTO_ACCOUNT_ID}"

    step "3" "Deploying"
    npx wrangler deploy; ok "akto-cloudflare-proxy deployed ✓"
    cd "$REPO_ROOT"
}

# ─── Main ─────────────────────────────────────────────────────────────────────
header "Akto  ×  Cloudflare  —  Deployment"

cat <<'BANNER'
  Intercept, analyse, and protect API traffic on Cloudflare Workers.

  Workers deployed by this script:
    akto-mini-runtime          — mini-runtime container (traffic to Akto)
    akto-guardrail-executor           — guardrail-executor container (Python scanner)
    akto-guardrails-executor   — guardrails-service container (policy enforcement)
    akto-ingest-guardrails     — data-ingestion-service container
    akto-cloudflare-proxy      — route worker (intercepts traffic)

  Note:
    akto-guardrail-executor URL is pre-configured in akto-guardrails-executor/wrangler.jsonc

BANNER

check_prereqs
_require_cloudflare_account_id
_require_akto_account_id

# ── Image push (optional) ─────────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Push Docker images to Cloudflare registry?${NC}"
echo "  Skip if images are already pushed."
echo ""
read -rp "  Push images? (y/N): " PUSH_IMAGES_ANSWER
if [[ "$PUSH_IMAGES_ANSWER" =~ ^[Yy]$ ]]; then
    _require_image_tag

    # Patch account ID + image tag into all wrangler.jsonc files
    for f in \
        "$REPO_ROOT/workers/akto-guardrails-executor/wrangler.jsonc" \
        "$REPO_ROOT/workers/akto-mini-runtime/wrangler.jsonc" \
        "$REPO_ROOT/workers/akto-ingest-guardrails/wrangler.jsonc" \
        "$REPO_ROOT/workers/akto-guardrail-executor/wrangler.jsonc"; do
        sed -i.bak \
            -e "s|registry.cloudflare.com/[^/]*/|registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/|g" \
            -e "s|\(registry\.cloudflare\.com/${CLOUDFLARE_ACCOUNT_ID}/[^:\"]*\):[^\"]*\"|\1:${IMAGE_TAG}\"|g" \
            "$f"
        rm -f "${f}.bak"
    done

    push_images
fi

# ── Deploy all workers ────────────────────────────────────────────────────────
deploy_mini_runtime
deploy_agent_guard_executor
deploy_guardrails_executor
deploy_ingest_guardrails
deploy_proxy

# ─── Summary ──────────────────────────────────────────────────────────────────
header "Deployment Complete"

echo -e "  ${GREEN}${BOLD}✓ All services deployed successfully!${NC}"
echo ""
echo "  Traffic flow:"
echo "    Client → akto-cloudflare-proxy → origin server"
echo "           ↳ async: akto-ingest-guardrails (binding)"
echo "                    → akto-guardrails-executor (binding) → policy check"
echo "                      → akto-guardrail-executor (HTTP) → guardrail-executor"
echo "                    → akto-mini-runtime (binding) → Akto"
echo ""
echo "  Next steps:"
echo "    1. Verify route is active: dash.cloudflare.com → Workers & Pages → Routes"
echo "    2. Send test traffic to your protected domain"
echo "    3. Check Akto Dashboard → API Collections for discovered APIs"
echo "    4. Check Akto Dashboard → Security Policies for guardrails status"
echo ""
echo "  Monitor logs:"
echo "    npx wrangler tail akto-cloudflare-proxy          --format pretty"
echo "    npx wrangler tail akto-ingest-guardrails         --format pretty"
echo "    npx wrangler tail akto-guardrails-executor       --format pretty"
echo "    npx wrangler tail akto-guardrail-executor               --format pretty"
echo "    npx wrangler tail akto-mini-runtime              --format pretty"
echo ""
echo -e "${GREEN}${BOLD}  Documentation: https://docs.akto.io/traffic-connector/api-gateways/cloudflare${NC}"
echo ""
