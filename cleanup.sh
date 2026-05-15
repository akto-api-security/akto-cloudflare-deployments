#!/bin/bash
# Akto Cloudflare Cleanup Script
# Deletes all deployed workers AND their container applications + DO namespaces.

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

header() { echo ""; echo -e "${BOLD}${BLUE}══════════════════════════════════════════${NC}";
           echo -e "${BOLD}${BLUE}  $1${NC}";
           echo -e "${BOLD}${BLUE}══════════════════════════════════════════${NC}"; echo ""; }
ok()     { echo -e "${GREEN}  ✓${NC}  $1"; }
warn()   { echo -e "${YELLOW}  !${NC}  $1"; }
err()    { echo -e "${RED}  ✗${NC}  $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env if present
ENV_FILE="$REPO_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; source "$ENV_FILE"; set +a
fi

WORKERS=(
    "akto-cloudflare-proxy"
    "akto-ingest-guardrails"
    "akto-guardrails-executor"
    "akto-agent-guard-executor"
    "akto-mini-runtime"
)

CONTAINER_APPS=(
    "akto-guardrails-executor-container"
    "akto-agent-guard-executor-container"
    "akto-mini-runtime-container"
    "akto-data-ingestion-container"
)

header "Akto × Cloudflare — Cleanup"

echo "  Workers to delete:"
for w in "${WORKERS[@]}"; do echo "    - $w"; done
echo ""
echo "  Container applications to delete:"
for c in "${CONTAINER_APPS[@]}"; do echo "    - $c"; done
echo ""
read -rp "  Continue? (y/N): " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "  Aborted."; exit 0; }

# ── Cloudflare account ID ─────────────────────────────────────────────────────
if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
    echo ""
    echo -e "${BOLD}  Cloudflare Account ID${NC}"
    echo "  ↳ https://dash.cloudflare.com → your account → Overview (right sidebar)"
    read -rp "  Account ID: " CLOUDFLARE_ACCOUNT_ID
    [ -z "$CLOUDFLARE_ACCOUNT_ID" ] && { err "Cannot be empty."; exit 1; }
fi
export CLOUDFLARE_ACCOUNT_ID

# ── Get CF API token from wrangler's stored OAuth config ──────────────────────
_get_cf_token() {
    # Wrangler stores OAuth tokens here on macOS
    local config="$HOME/Library/Preferences/.wrangler/config/default.toml"
    # Fallback path used on Linux / older wrangler versions
    local config_alt="$HOME/.wrangler/config/default.toml"

    for f in "$config" "$config_alt"; do
        if [ -f "$f" ]; then
            local token
            token=$(grep -oE 'oauth_token\s*=\s*"[^"]+"' "$f" 2>/dev/null | \
                    grep -oE '"[^"]+"' | tr -d '"' | head -1 || true)
            [ -n "$token" ] && { echo "$token"; return; }
        fi
    done
    echo ""
}

CF_TOKEN=$(_get_cf_token)
if [ -z "$CF_TOKEN" ]; then
    warn "Could not read wrangler OAuth token — container apps will be skipped."
    warn "Delete them manually: dash.cloudflare.com → Workers & Pages → Containers"
fi

# ── Delete workers ────────────────────────────────────────────────────────────
header "Deleting Workers"

for worker in "${WORKERS[@]}"; do
    echo -e "  Deleting worker ${BOLD}${worker}${NC}..."
    if npx wrangler delete --name "$worker" --force 2>&1 | grep -v "^\s*$"; then
        ok "$worker deleted"
    else
        warn "$worker not found — skipping"
    fi
done

# ── Delete container applications via CF API ──────────────────────────────────
header "Deleting Container Applications"

if [ -z "$CF_TOKEN" ]; then
    warn "Skipping container app deletion (no token)."
    warn "Delete manually from: dash.cloudflare.com → Workers & Pages → Containers"
else
    for app_name in "${CONTAINER_APPS[@]}"; do
        echo -e "  Deleting container app ${BOLD}${app_name}${NC}..."

        # List all container apps and find this one by name
        list_response=$(curl -s \
            "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/cloudchamber/applications" \
            -H "Authorization: Bearer ${CF_TOKEN}")

        app_id=$(echo "$list_response" | node -e "
            process.stdin.resume();
            let d = '';
            process.stdin.on('data', c => d += c);
            process.stdin.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    const a = (j.result || []).find(x => x.name === process.argv[1]);
                    console.log(a ? a.id : '');
                } catch(e) { console.log(''); }
            });
        " "$app_name" 2>/dev/null || echo "")

        if [ -n "$app_id" ]; then
            del_response=$(curl -s -X DELETE \
                "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/cloudchamber/applications/${app_id}" \
                -H "Authorization: Bearer ${CF_TOKEN}")
            ok "$app_name (id: $app_id) deleted"
        else
            warn "$app_name not found — already deleted or does not exist"
        fi
    done
fi

# ── Done ──────────────────────────────────────────────────────────────────────
header "Cleanup Complete"

echo -e "${GREEN}${BOLD}  ✓ All workers and container applications deleted.${NC}"
echo ""
echo "  Run ./deploy.sh for a fresh installation."
echo ""
