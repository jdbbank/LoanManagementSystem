#!/usr/bin/env bash
# Create or update one Kong route (the path a browser hits, bound to a service).
#
#   ./scripts/gateway/create-route.sh loan-api loan-api /api
#
# Re-running PATCHes the same route, so the command is safe to repeat. Kong matches overlapping
# prefix routes by longest path first, so /api wins over / no matter which one was created first.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"
load_kong_env_file "${SCRIPT_DIR}/../../.env"

usage() {
  cat <<'EOF'
Usage: create-route.sh <service-name> <route-name> <path> [more paths...] [options]

  <service-name>  an existing Kong service (see create-service.sh)
  <route-name>    the name this route is addressed by later
  <path>          one or more path prefixes, e.g. /api or /

Options:
  --methods <csv>          e.g. GET,POST,OPTIONS (default: every method)
  --strip-path             remove the matched prefix before forwarding
  --preserve-host          keep the original Host header for the upstream
  --https-only             restrict the route to the https protocol
  --priority <n>           Kong route priority, default 0
  --regex-priority <n>     only meaningful for regex paths
  -h, --help               show this help

Environment:
  KONG_ADMIN_URL       default http://127.0.0.1:8001
  KONG_WAIT_SECONDS    default 60
EOF
}

service=""
name=""
paths=()
methods=()
strip_path="false"
preserve_host="false"
protocols_http="true"
protocols_https="true"
priority=""
regex_priority=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --methods)
      [ "$#" -ge 2 ] || die "--methods needs a value"
      mapfile -t methods < <(csv_to_words "$2")
      shift 2
      ;;
    --strip-path) strip_path="true"; shift ;;
    --preserve-host) preserve_host="true"; shift ;;
    --https-only) protocols_http="false"; shift ;;
    --priority)
      [ "$#" -ge 2 ] || die "--priority needs a value"
      priority=$2
      shift 2
      ;;
    --regex-priority)
      [ "$#" -ge 2 ] || die "--regex-priority needs a value"
      regex_priority=$2
      shift 2
      ;;
    --*) die "unknown option: $1 (see --help)" ;;
    *)
      if [ -z "$service" ]; then
        service=$1
      elif [ -z "$name" ]; then
        name=$1
      else
        validate_path "$1"
        paths+=("$1")
      fi
      shift
      ;;
  esac
done

[ -n "$service" ] && [ -n "$name" ] && [ "${#paths[@]}" -gt 0 ] || { usage; exit 2; }
validate_name "$service"
validate_name "$name"
if [ -n "$priority" ]; then validate_int "$priority"; fi
if [ -n "$regex_priority" ]; then validate_int "$regex_priority"; fi

for method in "${methods[@]}"; do
  case "$method" in
    GET | HEAD | POST | PUT | PATCH | DELETE | OPTIONS | TRACE | CONNECT) ;;
    *) die "unsupported HTTP method: $method" ;;
  esac
done

protocols=()
[ "$protocols_http" = "true" ] && protocols+=("http")
[ "$protocols_https" = "true" ] && protocols+=("https")

payload="{\"name\":$(json_string "$name"),\"protocols\":$(json_string_array "${protocols[@]}"),\"paths\":$(json_string_array "${paths[@]}"),\"strip_path\":${strip_path},\"preserve_host\":${preserve_host},\"request_buffering\":true,\"response_buffering\":true"
if [ "${#methods[@]}" -gt 0 ]; then payload+=",\"methods\":$(json_string_array "${methods[@]}")"; fi
if [ -n "$priority" ]; then payload+=",\"priority\":${priority}"; fi
if [ -n "$regex_priority" ]; then payload+=",\"regex_priority\":${regex_priority}"; fi
payload+="}"

wait_for_kong
ensure_route "$service" "$name" "$payload"
info "  paths: ${paths[*]} -> service ${service}"
if [ "$KONG_DRY_RUN" != "true" ]; then info "  response: ${KONG_BODY}"; fi
