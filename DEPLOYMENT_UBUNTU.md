# Deploy on Ubuntu with Docker Compose

This setup runs MySQL 8.4, the Node.js API, and the React frontend in Docker.

Two Compose files ship with the project:

- `docker-compose.yml` — the shape used for development and the e2e suite. The frontend container is published on port 80 and proxies `/api` to the API, MySQL is published on 3307, Kafka on 9094.
- `docker-compose.prod.yml` — the production shape. Kong is the only container with a public port, no database or broker is reachable from outside the host, the API and mailer run unprivileged, and migrations run automatically. See [Production stack](#production-stack-docker-composeprodyml-with-kong).

Everything below this section describes `docker-compose.yml` unless a command shows the `-f` flag.

For a step-by-step production runbook in Thai (Ubuntu → firewall → `.env` → build → Kong gateway →
first administrator → TLS → backup → rollback), see [DEPLOY-STEPS-TH.md](DEPLOY-STEPS-TH.md).

## Requirements

- Ubuntu Server 22.04 or 24.04
- A DNS name and TLS reverse proxy for an internet-facing production deployment
- Git access to this project

Install Docker Engine and the Compose plugin using Docker's official Ubuntu instructions:
<https://docs.docker.com/engine/install/ubuntu/>

Verify the installation:

```bash
docker --version
docker compose version
```

## Get the project ready

Clone the repository on the server and enter its root directory:

```bash
git clone <repository-url> loan-management-system
cd loan-management-system
```

Create the deployment environment file and generate independent secrets:

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
chmod 600 .env
nano .env
```

Use the three generated values for `MYSQL_ROOT_PASSWORD`, `DB_PASSWORD`, and `JWT_SECRET`, respectively. Keep `.env` private and never commit it. `DB_USER` and `DB_NAME` can normally remain at their example values.

For the first run only, set `SEED_ON_BOOT=true` in `.env` if you want the application to create sample users, products, and customers. The seed accounts have known default passwords; change every seeded password immediately after the first login. For a deployment without sample data, leave `SEED_ON_BOOT=false` and provision an administrator using your approved process.

## Build and start

Build the application images, then start the database:

```bash
docker compose build
docker compose up -d mysql
docker compose ps
```

Wait until MySQL reports `healthy`. Then create the schema by running the versioned migrations. This is the only supported way to build tables: it applies `server/src/migrations` (starting with `BaselineSchema`, the full layout) and records what ran in the `schema_migrations` table.

```bash
docker compose run --rm backend npm run db:migrate -w server
docker compose run --rm backend npm run db:migrate:status -w server
```

The second command must print `[X] 1 BaselineSchema…`. Nothing in this setup uses TypeORM schema synchronization: `DB_SYNCHRONIZE` stays `false` (docker-compose pins it), and `NODE_ENV` no longer turns it on by itself.

Start the API and frontend:

```bash
docker compose up -d backend frontend
docker compose ps
docker compose logs --tail=100 backend frontend
```

Open `http://<server-ip>/` or the configured domain. The frontend container exposes port 80 by default. Set `FRONTEND_PORT` in `.env` if port 80 is already in use.

## Production stack (docker-compose.prod.yml with Kong)

Kong 3.x runs in traditional mode with its own Postgres database, and it is the only public entry
point. The web container stops proxying `/api` (it is built from `web/nginx.prod.conf`, static files
only) because two proxies in one request path is how duplicated headers and split log trails appear.

| | `docker-compose.yml` | `docker-compose.prod.yml` |
| --- | --- | --- |
| Routing | frontend Nginx proxies `/api` | Kong: `/` to the web container, `/api` to the API (prefix `/api` is not stripped — Express mounts its routers under it) |
| Published ports | 80, 3307, 9094 | 80 and 8443 by Kong, plus 8001 on `127.0.0.1` only |
| Data plane | MySQL and Kafka reachable from the host | MySQL, Kafka, Zookeeper and Kong's Postgres sit on a private network with no host port |
| Migrations | run by hand, once | one-shot services `db-migrate` and `kong-migrations`; `backend` and `kong` start only after they exit 0 |
| Process user | root | API and mailer run as `node`; the API's hourly log directory is the named volume `loan_backend_logs` |
| Resource control | none | CPU and memory ceiling plus `json-file` log rotation on every service |

### Start it

```bash
cp .env.example .env
chmod 600 .env
nano .env                       # MYSQL_ROOT_PASSWORD, DB_PASSWORD, JWT_SECRET, KONG_PG_PASSWORD,
                                # NOTIFY_SECRET_KEY, MAILER_API_KEY, WEB_PUBLIC_URL all have no default

docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

`up -d` applies the application migrations and the Kong schema by itself; both one-shots are safe to
re-run (`migration:run` reports `No migrations are pending`, and `kong migrations bootstrap` on an
already bootstrapped database continues into `up` and `finish`). If Kong ever starts before its
schema exists, force the one-shot again:

```bash
docker compose -f docker-compose.prod.yml run --rm kong-migrations
```

Then wire the gateway — services, routes and the global plugins:

```bash
./scripts/gateway/bootstrap.sh
./scripts/gateway/status.sh
```

`scripts/gateway/` is plain `bash` + `curl`; see its README for the individual
`create-service.sh` / `create-route.sh` commands and every `KONG_*` knob. Run `KONG_DRY_RUN=true
./scripts/gateway/bootstrap.sh` first if you want to see the JSON bodies without touching a live
gateway.

### Check it from outside

```bash
curl -i http://<server-ip>/                    # 200 and the React index page
curl -i http://<server-ip>/api/auth/me         # 401 JSON: Kong reached Express and the guard answered
curl -i http://<server-ip>/manual              # 200: the SPA fallback still works through Kong
```

A `502` or `503` from the gateway means Kong cannot resolve or reach the upstream container — check
that `frontend` and `backend` are both on the `edge` network. An HTTP-level error from `/api` means
routing worked and the API itself answered.

### Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Nothing else needs an inbound rule. The Kong Admin API is mapped to `127.0.0.1:8001`, so it is
reachable from the host (that is where `scripts/gateway/*.sh` runs) and from no other address. Do not
change that mapping to `8001:8001`.

### TLS

Kong terminates TLS itself, so no separate Caddy or Nginx is needed in front of it:

```yaml
# docker-compose.prod.yml -> services.kong
    environment:
      KONG_PROXY_LISTEN: "0.0.0.0:8000, 0.0.0.0:8443 ssl http2"
      KONG_SSL_CERT: /etc/kong/certs/fullchain.pem
      KONG_SSL_CERT_KEY: /etc/kong/certs/privkey.pem
    volumes:
      - ./certs:/etc/kong/certs:ro
    ports:
      - "443:8443"
```

Set `KONG_HTTPS_PORT=443` in `.env` instead of editing the file twice, and update `WEB_PUBLIC_URL` to
the `https://` origin, because the reset and settlement links inside emails are built from it.
Until a real certificate is installed, Kong serves its built-in default certificate on 8443 — which
is why `KONG_HTTPS_PORT` defaults to 8443 rather than 443.

### Two production gaps that are still open

Both are in application code, so they are reported rather than changed here.

1. **Client IP is lost behind Kong.** `server/src/app.ts` never calls `app.set('trust proxy', ...)`,
   so Express reports the Kong container's address as `req.ip` for every request. That affects the
   audit trail (every row records the same IP) and, more importantly, the forgot-password IP throttle
   in `auth.router.ts` (`isIpThrottled`), which then treats the whole branch as one client: after a
   handful of reset requests everyone is locked out until the window passes. The one-line fix is
   `app.set('trust proxy', 1)` right after `const app = express()` — trusting exactly one proxy hop,
   which is what this topology has.
2. **CORS is doubled if the Kong plugin is enabled.** `app.use(cors())` already answers with
   `Access-Control-Allow-Origin: *`. A `cors` plugin on top adds a second ACAO header and browsers
   reject such a response outright. `bootstrap.sh` therefore leaves it off (`KONG_ENABLE_CORS=false`),
   which is also correct on its own: with Kong serving app and API from one origin the browser makes
   no cross-origin request at all. The real tightening is to give `cors()` an explicit allow-list
   instead of `*`.

Also note that the e2e suite expects MySQL on `127.0.0.1:3307` and the API without a gateway, so it
runs against `docker-compose.yml`. Pointing it at the production stack needs `bootstrap.sh
--no-plugins` (the rate limiter rejects its request rate) plus a published database port, which the
production file deliberately does not have.

## Database access and firewall

MySQL is published as `3307:3306` for compatibility with the requested host port. The application itself connects to MySQL over the private Compose network on port 3306. Do not expose port 3307 to the public internet; restrict it to a trusted administration IP or remove the `ports` mapping if remote database access is not needed.

Example UFW rules for a web server that should only accept HTTP/HTTPS publicly:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

If database administration from a remote machine is required, add a source-restricted rule instead of allowing port 3307 globally:

```bash
sudo ufw allow from <trusted-admin-ip> to any port 3307 proto tcp
```

Use HTTPS in production. Put a TLS reverse proxy such as Caddy or an appropriately configured Nginx in front of the frontend; do not send login credentials over plain HTTP on an internet-facing server.

## Operations

```bash
# Follow logs
docker compose logs -f

# Restart services
docker compose restart

# Deploy newer source
git pull
docker compose build
docker compose run --rm backend npm run db:migrate -w server
docker compose up -d

# Stop containers while preserving database data
docker compose down
```

On the production stack every one of those commands carries `-f docker-compose.prod.yml`:

```bash
docker compose -f docker-compose.prod.yml logs -f backend kong

git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d   # db-migrate runs again, before the API restarts
./scripts/gateway/bootstrap.sh                    # only when routes, upstreams or limits changed

docker compose -f docker-compose.prod.yml down
```

`docker compose -f docker-compose.prod.yml down -v` deletes the loan database, Kong's database and
the archived API logs in one step. Use it only when wiping the machine is the goal.

MySQL data is stored in the named volume `loan_mysql_data`. Back it up regularly using a database-aware backup process and test restores. `docker compose down -v` deletes the database volume and all stored application data; do not use it for routine shutdown or deployment.

## Schema changes and migrations

`server/src/migrations` is the source of truth for the table layout. A database is created by `npm run db:migrate -w server` and moves forward the same way; schema synchronization is not used anywhere (`DB_SYNCHRONIZE` is only an escape hatch for a scratch database, and every migration command forces it off).

To change the layout, edit the entity, then generate a delta on a development database:

```bash
npm run db:migration:generate -w server -- src/migrations/AddPenaltyCap   # builds first, writes one file
npm run db:schema:diff -w server                                          # must then report "up to date"
npm run test:migrations                                                   # compares migrations with the live schema, row by row
```

Review the generated SQL before committing it — it is the statement of what will happen to production data. Never hand-edit `BaselineSchema`; add a new migration instead. `npm run db:migrate:status -w server` lists what a database has applied, which is also the check that a deploy finished.

One generated shape must always be rewritten by hand: widening an `enum` column. TypeORM emits `DROP COLUMN` + `ADD COLUMN`, and on a table that already has rows that is not a no-op — the values of the column are replaced by its first member, and a UNIQUE index that includes the column is silently shortened to its remaining columns (`email_templates.code` collapsing to `(locale)` would break the ALTER outright). `MODIFY COLUMN ... enum (...)` with the old members in the same order does the same widening in place, keeps every row, and is what `HardshipRestructure` uses.

`npm run db:migrate:revert -w server` undoes the newest migration. Reverting `BaselineSchema` would drop the 23 tables it creates and every row in them, so it is blocked unless `DB_BASELINE_REVERT=I-ACCEPT-DATA-LOSS` is set; that combination belongs to a scratch database only. Rehearse any migration that rewrites a column on a restored copy of production data, not on the live volume.

## Restore rehearsal

A backup that has never been restored is a hope, not a backup. Rehearse on a schedule (the project's own dump tooling is `npm run test:e2e:backup`, which writes `backups/*.sql`):

```bash
docker exec loan-ms-mysql mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction loan_management > backup-$(date +%F).sql
docker exec -i loan-ms-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "CREATE DATABASE loan_ms_restore_probe"
docker exec -i loan-ms-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" loan_ms_restore_probe < backup-2026-10-14.sql
docker exec -i loan-ms-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e \
  "SELECT COUNT(*) FROM loan_ms_restore_probe.financial_transactions; \
   SELECT COUNT(*) FROM loan_management.financial_transactions"
docker exec -i loan-ms-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "DROP DATABASE loan_ms_restore_probe"
```

The two counts must match, and `npm run db:migrate -w server` against the restored copy must report `No migrations are pending` — that proves the dump is both complete and current. Record the date and the numbers somewhere durable; an untested restore is the readiness gap this section exists to close.
