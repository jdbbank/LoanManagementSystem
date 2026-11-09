#!/usr/bin/env bash
# Show what the Kong gateway currently holds, and probe it through the proxy.
#
#   ./scripts/gateway/status.sh

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"
load_kong_env_file "${SCRIPT_DIR}/../../.env"

show() {
  local label="$1" path="$2"
  kong_get "$path" || true
  if _unreachable; then die "cannot reach the Kong Admin API at ${KONG_ADMIN_URL}"; fi
  info "=== ${label} [${KONG_STATUS}] ${KONG_ADMIN_URL}${path}"
  info "${KONG_BODY}"
  info ""
}

probe() {
  local url="$1" code
  code=$(curl -sS -o /dev/null -m "$KONG_CURL_TIMEOUT" -w '%{http_code}' "$url") || code="unreachable"
  info "  ${code}  ${url}"
}

wait_for_kong

show "node" "/status"
show "services" "/services"
show "routes" "/routes"
show "plugins" "/plugins"

info "=== proxy probes (200 for the app, 401 for an unauthenticated API call is healthy)"
proxy_url="${KONG_PROXY_URL:-http://127.0.0.1}"
probe "${proxy_url}/"
probe "${proxy_url}/api/auth/me"
