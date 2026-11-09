#!/usr/bin/env bash
# Shared helpers for the Kong gateway scripts.
#
# Kong runs in traditional mode (Postgres-backed) in docker-compose.prod.yml, so every object is
# created through the Admin API rather than a declarative file. The Admin API is published on the
# host loopback only (127.0.0.1:8001), which is why these scripts are meant to run on the host.
#
# Idempotency rule used throughout: GET the object by its name, then PATCH it if it exists or POST
# it if it does not. PUT-upsert is deliberately avoided - it behaves differently across Kong
# versions and on the route collection it silently moves routes between services.

set -euo pipefail

KONG_ADMIN_URL="${KONG_ADMIN_URL:-http://127.0.0.1:8001}"
KONG_WAIT_SECONDS="${KONG_WAIT_SECONDS:-60}"
KONG_CURL_TIMEOUT="${KONG_CURL_TIMEOUT:-15}"
# true = print the JSON body that would be sent and stop. Lets an operator (or a CI lint step) check
# the payload before anything is written to a running gateway.
KONG_DRY_RUN="${KONG_DRY_RUN:-false}"

# Set by every kong_* call below: the HTTP status code and the raw response body.
KONG_STATUS=""
KONG_BODY=""

info() { printf '%s\n' "$*"; }
warn() { printf 'warn: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- low level ------------------------------------------------------------

# _request <METHOD> <path> [json-payload]
# Returns 1 (and leaves KONG_STATUS as "000") when the Admin API could not be reached at all.
_request() {
  local method="$1" path="$2" payload="${3:-}"
  local raw

  KONG_STATUS=""
  KONG_BODY=""

  if [ -n "$payload" ]; then
    if ! raw=$(curl -s -m "$KONG_CURL_TIMEOUT" -X "$method" \
      -H 'Content-Type: application/json' --data-binary "$payload" \
      -w '\n%{http_code}' "${KONG_ADMIN_URL}${path}"); then
      KONG_STATUS="000"
      return 1
    fi
  else
    if ! raw=$(curl -s -m "$KONG_CURL_TIMEOUT" -X "$method" \
      -w '\n%{http_code}' "${KONG_ADMIN_URL}${path}"); then
      KONG_STATUS="000"
      return 1
    fi
  fi

  # curl appended the status on its own last line, so it is safe to split there: response bodies
  # may contain newlines but the status never does.
  KONG_STATUS=${raw##*$'\n'}
  KONG_BODY=${raw%$'\n'*}
  return 0
}

kong_get() { _request GET "$1"; }
kong_post() { _request POST "$1" "$2"; }
kong_patch() { _request PATCH "$1" "$2"; }

_unreachable() {
  [ "$KONG_STATUS" = "000" ]
}

wait_for_kong() {
  if [ "$KONG_DRY_RUN" = "true" ]; then
    info "dry run: nothing will be sent to ${KONG_ADMIN_URL}"
    return 0
  fi
  local deadline now
  now=$(date +%s)
  deadline=$((now + KONG_WAIT_SECONDS))
  while [ "$now" -lt "$deadline" ]; do
    if kong_get /status && [ "$KONG_STATUS" = "200" ]; then
      info "Kong Admin API ready at ${KONG_ADMIN_URL}"
      return 0
    fi
    sleep 2
    now=$(date +%s)
  done
  die "Kong Admin API at ${KONG_ADMIN_URL} did not answer within ${KONG_WAIT_SECONDS}s. Is 'docker compose -f docker-compose.prod.yml up -d' running?"
}

# Optional .env reader for the KONG_* knobs. The file is never sourced: values such as MAIL_FROM
# contain spaces and angle brackets, and a source of that would be both fragile and an eval.
load_kong_env_file() {
  local file="$1" line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      KONG_*=*) ;;
      *) continue ;;
    esac
    key=${line%%=*}
    value=${line#*=}
    value=${value%\"}
    value=${value#\"}
    export "${key}=${value}"
  done <"$file"
}

# --- payload building -----------------------------------------------------

# json_string <value>  -> "value" with the two characters that need escaping handled.
json_string() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '"%s"' "$value"
}

# Names go straight into the URL path, so they must stay plain tokens.
validate_name() {
  case "$1" in
    '' | *[!A-Za-z0-9._~-]*) die "invalid name: $1 (allowed: letters, digits, . _ ~ -)" ;;
  esac
}

# Paths and method lists arrive from the command line; keep them to what Kong accepts.
validate_path() {
  [[ "$1" =~ ^/[A-Za-z0-9._~/:%-]*$ ]] || die "invalid route path: $1 (must start with / and contain no spaces)"
}

validate_int() {
  [[ "$1" =~ ^[0-9]+$ ]] || die "expected a non-negative integer, got: $1"
}

# A comma separated list of tokens -> a JSON array of strings.
json_string_array() {
  local out="" item first=1
  for item in "$@"; do
    [ "$first" = "1" ] || out+=","
    out+="$(json_string "$item")"
    first=0
  done
  printf '[%s]' "$out"
}

csv_to_words() {
  local IFS=','
  # shellcheck disable=SC2206 # word splitting on commas is the point here
  local parts=($1)
  local out=() part
  for part in "${parts[@]}"; do
    part=${part#"${part%%[![:space:]]*}"}
    part=${part%"${part##*[![:space:]]}"}
    [ -n "$part" ] && out+=("$part")
  done
  printf '%s\n' "${out[@]}"
}

# --- object helpers -------------------------------------------------------

# ensure_service <name> <payload>
ensure_service() {
  local name="$1" payload="$2" action

  validate_name "$name"
  if [ "$KONG_DRY_RUN" = "true" ]; then
    info "dry run | service ${name}: POST /services, or PATCH /services/${name} if it already exists"
    info "$payload"
    return 0
  fi
  kong_get "/services/${name}" || true
  case "$KONG_STATUS" in
    200) action="updated"
      kong_patch "/services/${name}" "$payload" || true
      ;;
    404) action="created"
      kong_post "/services" "$payload" || true
      ;;
    000) die "cannot reach the Kong Admin API at ${KONG_ADMIN_URL}" ;;
    *) die "GET /services/${name} returned ${KONG_STATUS}: ${KONG_BODY}" ;;
  esac
  if _unreachable; then die "cannot reach the Kong Admin API at ${KONG_ADMIN_URL}"; fi
  case "$KONG_STATUS" in
    200 | 201) ;;
    *) die "could not ${action} service ${name}: ${KONG_STATUS} ${KONG_BODY}" ;;
  esac
  info "service ${name}: ${action} (${KONG_STATUS})"
}

# ensure_route <service-name> <route-name> <payload>
ensure_route() {
  local service="$1" name="$2" payload="$3" action

  validate_name "$service"
  validate_name "$name"
  if [ "$KONG_DRY_RUN" = "true" ]; then
    info "dry run | route ${name} on ${service}: POST /services/${service}/routes, or PATCH /routes/${name} if it already exists"
    info "$payload"
    return 0
  fi
  kong_get "/routes/${name}" || true
  case "$KONG_STATUS" in
    200) action="updated"
      kong_patch "/routes/${name}" "$payload" || true
      ;;
    404) action="created"
      # Creating under the service binds the route in one call, so no name-or-id lookup is needed.
      kong_post "/services/${service}/routes" "$payload" || true
      ;;
    000) die "cannot reach the Kong Admin API at ${KONG_ADMIN_URL}" ;;
    *) die "GET /routes/${name} returned ${KONG_STATUS}: ${KONG_BODY}" ;;
  esac
  if _unreachable; then die "cannot reach the Kong Admin API at ${KONG_ADMIN_URL}"; fi
  case "$KONG_STATUS" in
    200 | 201) ;;
    *) die "could not ${action} route ${name}: ${KONG_STATUS} ${KONG_BODY}" ;;
  esac
  info "route ${name} on service ${service}: ${action} (${KONG_STATUS})"
}

# ensure_plugin <scope> <plugin-name> <payload>
# Scope is "global" or "service:<name>" or "route:<name>". Existing plugins are found by name
# inside that scope and PATCHed, so re-running a bootstrap never produces duplicates.
ensure_plugin() {
  local scope="$1" name="$2" payload="$3" list_url id

  validate_name "$name"
  case "$scope" in
    global) list_url="/plugins?name=${name}" ;;
    service:*) list_url="/services/${scope#service:}/plugins?name=${name}" ;;
    route:*) list_url="/routes/${scope#route:}/plugins?name=${name}" ;;
    *) die "unknown plugin scope: $scope" ;;
  esac

  if [ "$KONG_DRY_RUN" = "true" ]; then
    info "dry run | plugin ${name} in scope ${scope}: POST ${list_url%%\?*}, or PATCH /plugins/<id> if it already exists"
    info "$payload"
    return 0
  fi

  kong_get "$list_url" || true
  if _unreachable; then die "cannot reach the Kong Admin API at ${KONG_ADMIN_URL}"; fi
  [ "$KONG_STATUS" = "200" ] || die "GET ${list_url} returned ${KONG_STATUS}: ${KONG_BODY}"

  # Kong ids are UUIDs; a missing match makes grep exit 1, which pipefail would otherwise turn
  # into a fatal error even though "no plugin yet" is the normal first run.
  id=$(printf '%s' "$KONG_BODY" | { grep -o '"id":"[0-9a-fA-F-]\{36\}"' || true; } | head -n 1 |
    sed 's/^"id":"//; s/"$//')
  if [ -n "$id" ]; then
    kong_patch "/plugins/${id}" "$payload" || true
    case "$KONG_STATUS" in
      200) info "plugin ${name} (${scope}): updated" ;;
      *) die "could not update plugin ${name} (${scope}): ${KONG_STATUS} ${KONG_BODY}" ;;
    esac
  else
    kong_post "${list_url%%\?*}" "$payload" || true
    case "$KONG_STATUS" in
      201) info "plugin ${name} (${scope}): created" ;;
      *) die "could not create plugin ${name} (${scope}): ${KONG_STATUS} ${KONG_BODY}" ;;
    esac
  fi
}
