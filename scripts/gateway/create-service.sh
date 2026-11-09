#!/usr/bin/env bash
# Create or update one Kong service (an upstream the gateway forwards to).
#
#   ./scripts/gateway/create-service.sh loan-api backend 4000 --path /api
#
# Re-running the command PATCHes the same service instead of failing, so it is safe to keep in
# runbooks and CI. Nothing is deleted, which also means routes already attached to the service stay.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"
load_kong_env_file "${SCRIPT_DIR}/../../.env"

usage() {
  cat <<'EOF'
Usage: create-service.sh <name> <upstream-host> <port> [options]

  <name>           Kong service name, e.g. loan-api
  <upstream-host>  host reachable from the kong container, e.g. backend or frontend
  <port>           TCP port on that host, e.g. 4000

Options:
  --protocol <p>      http (default), https, grpc, grpcs, tcp, udp
  --path <prefix>     prefix Kong sends along, e.g. /api
  --retries <n>       upstream retries, default 5
  --connect-timeout <ms>   default 60000
  --write-timeout <ms>     default 60000
  --read-timeout <ms>      default 60000
  --tag <tag>         repeatable
  -h, --help          show this help

Environment:
  KONG_ADMIN_URL      default http://127.0.0.1:8001
  KONG_WAIT_SECONDS   how long to wait for the Admin API, default 60
EOF
}

name=""
host=""
port=""
protocol="http"
path=""
retries="5"
connect_timeout="60000"
write_timeout="60000"
read_timeout="60000"
tags=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --protocol)
      [ "$#" -ge 2 ] || die "--protocol needs a value"
      protocol=$2
      shift 2
      ;;
    --path)
      [ "$#" -ge 2 ] || die "--path needs a value"
      path=$2
      shift 2
      ;;
    --retries)
      [ "$#" -ge 2 ] || die "--retries needs a value"
      retries=$2
      shift 2
      ;;
    --connect-timeout)
      [ "$#" -ge 2 ] || die "--connect-timeout needs a value"
      connect_timeout=$2
      shift 2
      ;;
    --write-timeout)
      [ "$#" -ge 2 ] || die "--write-timeout needs a value"
      write_timeout=$2
      shift 2
      ;;
    --read-timeout)
      [ "$#" -ge 2 ] || die "--read-timeout needs a value"
      read_timeout=$2
      shift 2
      ;;
    --tag)
      [ "$#" -ge 2 ] || die "--tag needs a value"
      tags+=("$2")
      shift 2
      ;;
    --*) die "unknown option: $1 (see --help)" ;;
    *)
      if [ -z "$name" ]; then
        name=$1
      elif [ -z "$host" ]; then
        host=$1
      elif [ -z "$port" ]; then
        port=$1
      else
        die "unexpected argument: $1"
      fi
      shift
      ;;
  esac
done

[ -n "$name" ] && [ -n "$host" ] && [ -n "$port" ] || { usage; exit 2; }
validate_name "$name"
validate_name "$host"
validate_int "$port"
validate_int "$retries"
validate_int "$connect_timeout"
validate_int "$write_timeout"
validate_int "$read_timeout"
if [ -n "$path" ]; then validate_path "$path"; fi
case "$protocol" in
  http | https | grpc | grpcs | tcp | udp) ;;
  *) die "unsupported protocol: $protocol" ;;
esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "port out of range: $port"

payload="{\"name\":$(json_string "$name"),\"protocol\":$(json_string "$protocol"),\"host\":$(json_string "$host"),\"port\":${port},\"retries\":${retries},\"connect_timeout\":${connect_timeout},\"write_timeout\":${write_timeout},\"read_timeout\":${read_timeout}"
if [ -n "$path" ]; then payload+=",\"path\":$(json_string "$path")"; fi
if [ "${#tags[@]}" -gt 0 ]; then payload+=",\"tags\":$(json_string_array "${tags[@]}")"; fi
payload+="}"

wait_for_kong
ensure_service "$name" "$payload"
info "  upstream: ${protocol}://${host}:${port}${path}"
if [ "$KONG_DRY_RUN" != "true" ]; then info "  response: ${KONG_BODY}"; fi
