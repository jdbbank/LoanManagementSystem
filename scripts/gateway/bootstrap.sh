#!/usr/bin/env bash
# Wire the production gateway: two services, two routes and the global plugins.
#
#   ./scripts/gateway/bootstrap.sh
#
# Run it once after 'docker compose -f docker-compose.prod.yml up -d', and again whenever the
# limits below change. Every step is idempotent - existing objects are PATCHed, never duplicated.
#
# Result:
#   http://<host>:80/      -> frontend container (static React app, nginx serves the SPA fallback)
#   http://<host>:80/api/.. -> backend container (Express keeps its /api prefix: strip_path is off)

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"
load_kong_env_file "${SCRIPT_DIR}/../../.env"

usage() {
  cat <<'EOF'
Usage: bootstrap.sh [--with-cors] [--no-plugins]

Environment (all optional, .env is read for KONG_* keys):
  KONG_WEB_SERVICE / KONG_API_SERVICE      service names, default loan-web / loan-api
  KONG_WEB_ROUTE   / KONG_API_ROUTE        route names,   default loan-web / loan-api
  KONG_WEB_HOST    / KONG_API_HOST         upstream hosts, default frontend / backend
  KONG_WEB_PORT    / KONG_API_PORT         upstream ports, default 80 / 4000
  KONG_RATE_LIMIT_SECOND                   per-second global limit, default 20 (0 disables)
  KONG_RATE_LIMIT_MINUTE                   per-minute global limit, default 600 (0 disables)
  KONG_MAX_REQUEST_SIZE_KB                 request-size-limiting, default 10240
  KONG_ENABLE_CORS                         true to install the cors plugin, default false
  KONG_CORS_ORIGINS                        comma separated origins when CORS is enabled
  KONG_ADMIN_URL                           default http://127.0.0.1:8001
  KONG_PROXY_URL                           used for the final probe, default http://127.0.0.1
EOF
}

web_service="${KONG_WEB_SERVICE:-loan-web}"
api_service="${KONG_API_SERVICE:-loan-api}"
web_route="${KONG_WEB_ROUTE:-loan-web}"
api_route="${KONG_API_ROUTE:-loan-api}"
web_host="${KONG_WEB_HOST:-frontend}"
api_host="${KONG_API_HOST:-backend}"
web_port="${KONG_WEB_PORT:-80}"
api_port="${KONG_API_PORT:-4000}"
rate_second="${KONG_RATE_LIMIT_SECOND:-20}"
rate_minute="${KONG_RATE_LIMIT_MINUTE:-600}"
max_request_kb="${KONG_MAX_REQUEST_SIZE_KB:-10240}"
enable_cors="${KONG_ENABLE_CORS:-false}"
cors_origins="${KONG_CORS_ORIGINS:-}"
with_plugins="true"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-cors) enable_cors="true"; shift ;;
    --no-plugins) with_plugins="false"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

validate_name "$web_service"
validate_name "$api_service"
validate_name "$web_route"
validate_name "$api_route"
validate_name "$web_host"
validate_name "$api_host"
validate_int "$web_port"
validate_int "$api_port"
validate_int "$rate_second"
validate_int "$rate_minute"
validate_int "$max_request_kb"

wait_for_kong

info "--- services and routes ---"
"${SCRIPT_DIR}/create-service.sh" "$web_service" "$web_host" "$web_port"
"${SCRIPT_DIR}/create-route.sh" "$web_service" "$web_route" "/"
"${SCRIPT_DIR}/create-service.sh" "$api_service" "$api_host" "$api_port"
# strip_path stays false: the Express app mounts its routers under /api and must see that prefix.
"${SCRIPT_DIR}/create-route.sh" "$api_service" "$api_route" "/api"

if [ "$with_plugins" = "true" ]; then
  info "--- global plugins ---"

  # The browser talks to the same origin it was served from, so the SPA needs no CORS at all.
  # Keep this off unless something really is cross-origin: server/src/app.ts already answers with
  # Access-Control-Allow-Origin: * (a bare app.use(cors())), and a cors plugin on top of that
  # produces two ACAO headers in one response - which every browser rejects.
  if [ "$enable_cors" = "true" ]; then
    [ -n "$cors_origins" ] || die "KONG_CORS_ORIGINS is required when CORS is enabled (a * origin cannot carry credentials)"
    cors_origins_list=()
    mapfile -t cors_origins_list < <(csv_to_words "$cors_origins")
    cors_payload="{\"name\":\"cors\",\"config\":{\"origins\":$(json_string_array "${cors_origins_list[@]}"),\"methods\":[\"GET\",\"POST\",\"PUT\",\"PATCH\",\"DELETE\",\"OPTIONS\",\"HEAD\"],\"headers\":[\"Accept\",\"Authorization\",\"Content-Type\",\"X-Requested-With\"],\"credentials\":true,\"max_age\":600,\"preflight_continue\":false}}"
    ensure_plugin global cors "$cors_payload"
  else
    info "plugin cors: skipped (same-origin app; app.use(cors()) already sets ACAO - enabling both duplicates the header)"
  fi

  # One bucket per client IP, counters in this Kong node only. Raise the numbers, or run with
  # --no-plugins, before pointing the e2e suite at the gateway: it fires far more than 20 req/s.
  rate_config=""
  if [ "$rate_second" -gt 0 ]; then rate_config+="\"second\":${rate_second},"; fi
  if [ "$rate_minute" -gt 0 ]; then rate_config+="\"minute\":${rate_minute},"; fi
  if [ -n "$rate_config" ]; then
    ensure_plugin global rate-limiting \
      "{\"name\":\"rate-limiting\",\"config\":{\"policy\":\"local\",\"hide_client_headers\":false,${rate_config%,}}}"
  else
    info "plugin rate-limiting: skipped (both limits are 0)"
  fi

  # KYC uploads are images with a server-side cap; this is the outer guard so an oversized body is
  # refused at the edge instead of reaching Express.
  ensure_plugin global request-size-limiting \
    "{\"name\":\"request-size-limiting\",\"config\":{\"allowed_payload_size\":${max_request_kb},\"error_code\":413,\"error_message\":\"request body too large\"}}"
fi

info "--- probe through the proxy ---"
proxy_url="${KONG_PROXY_URL:-http://127.0.0.1}"
if [ "$KONG_DRY_RUN" = "true" ]; then
  info "  skipped (dry run)"
else
  for probe in "${proxy_url}/" "${proxy_url}/api/auth/me"; do
    code=$(curl -sS -o /dev/null -m "$KONG_CURL_TIMEOUT" -w '%{http_code}' "$probe") || code="unreachable"
    info "  ${code}  ${probe}"
  done
fi
info "expected: 200 for the app root, 401 for /api/auth/me (no token). 502/503 means Kong cannot reach"
info "the upstream container - check that both are on the 'edge' network."
