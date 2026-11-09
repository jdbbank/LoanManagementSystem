# Kong gateway scripts

Plain `bash` + `curl`, no build step, no extra dependency. They talk to the Kong Admin API of the
production stack (`docker-compose.prod.yml`), which runs Kong in traditional mode with its own
Postgres database.

The Admin API is published on the host loopback only (`127.0.0.1:8001`), so run these **on the host**
where the stack runs, not from inside another container.

## Order

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d     # waits for the db-migrate and kong-migrations
                                                   # one-shots to exit successfully before starting
./scripts/gateway/bootstrap.sh                      # services + routes + global plugins
./scripts/gateway/status.sh                         # what Kong holds now, plus two proxy probes
```

`bootstrap.sh` is idempotent: every object is looked up by name and PATCHed if it exists, POSTed if
it does not. Run it again after changing a limit. PUT-upsert is deliberately not used - on the route
collection it can move a route to a different service.

## Files

| file | what it does |
| --- | --- |
| `lib.sh` | sourced by the others: Admin API call helpers, wait-for-Kong, name/path validation, JSON building, idempotent `ensure_service` / `ensure_route` / `ensure_plugin` |
| `bootstrap.sh` | the whole production wiring in one go |
| `create-service.sh <name> <host> <port>` | one upstream service (`--path`, `--retries`, timeouts, `--tag`) |
| `create-route.sh <service> <route> <path>...` | one route (`--methods`, `--strip-path`, `--preserve-host`, `--https-only`, priorities) |
| `status.sh` | dumps `/status`, services, routes, plugins and probes the proxy |

Every script accepts `--help`.

## What bootstrap.sh creates

| object | value | why |
| --- | --- | --- |
| service `loan-web` | `frontend:80` | static React app |
| route `loan-web` | `/` | SPA fallback is nginx's job, so any path that is not `/api` lands here |
| service `loan-api` | `backend:4000` | Express API |
| route `loan-api` | `/api`, `strip_path=false` | the app mounts its routers under `/api` and must keep receiving that prefix |
| plugin `rate-limiting` (global) | 20 req/s, 600 req/min per client IP | brute-force and scraper guard at the edge |
| plugin `request-size-limiting` (global) | 10 MiB | KYC images are capped server-side; oversized bodies should never reach Node |
| plugin `cors` (global) | **off by default** | see the warning below |

Kong matches overlapping prefix routes longest-first, so `/api` always wins over `/` regardless of
creation order.

## Knobs (env or `.env`, all `KONG_*`)

`KONG_ADMIN_URL` (default `http://127.0.0.1:8001`), `KONG_PROXY_URL` (probes),
`KONG_WEB_SERVICE` / `KONG_WEB_ROUTE` / `KONG_WEB_HOST` / `KONG_WEB_PORT`,
`KONG_API_SERVICE` / `KONG_API_ROUTE` / `KONG_API_HOST` / `KONG_API_PORT`,
`KONG_RATE_LIMIT_SECOND`, `KONG_RATE_LIMIT_MINUTE`, `KONG_MAX_REQUEST_SIZE_KB`,
`KONG_ENABLE_CORS`, `KONG_CORS_ORIGINS`, `KONG_WAIT_SECONDS`, `KONG_CURL_TIMEOUT`.

`bootstrap.sh`, `create-service.sh`, `create-route.sh` and `status.sh` read `KONG_*` lines from the
repository `.env` (they never `source` it, because values such as `MAIL_FROM` contain spaces and
angle brackets).

## Two warnings that are easy to miss

**Do not enable the `cors` plugin while `server/src/app.ts` still calls a bare `cors()`.** The app
answers every response with `Access-Control-Allow-Origin: *`. A cors plugin on top adds a second
ACAO header, and browsers reject a response that carries two. It is also unnecessary here: Kong
serves the app and the API from the same origin, so the SPA makes no cross-origin call at all.

**The rate limiter will trip the e2e suite.** `npm run test:e2e:full` issues far more than 20
requests per second. Use `bootstrap.sh --no-plugins`, or raise `KONG_RATE_LIMIT_SECOND`, before
pointing a test run at the gateway. The suite normally runs against `docker-compose.yml` (dev), which
has no Kong in front of it.

## Removing an object

The scripts only create and update, never delete, so an accidental run cannot take the site down.
Deleting is a one-liner against the Admin API when you really mean it:

```bash
curl -X DELETE "$KONG_ADMIN_URL/routes/loan-api"     # or /services/loan-api (cascades to its routes)
```
