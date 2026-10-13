# Deploy on Ubuntu with Docker Compose

This setup runs MySQL 8.4, the Node.js API, and the React frontend in Docker. The frontend is served by Nginx and proxies `/api` requests to the API container.

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

Wait until MySQL reports `healthy`. On a **new, empty database**, create the initial tables once. This explicit bootstrap enables TypeORM schema synchronization for this command only; the running backend remains in production mode with synchronization disabled.

```bash
docker compose run --rm -e DB_SYNCHRONIZE=true backend npm run db:schema --workspace server
```

Start the API and frontend:

```bash
docker compose up -d backend frontend
docker compose ps
docker compose logs --tail=100 backend frontend
```

Open `http://<server-ip>/` or the configured domain. The frontend container exposes port 80 by default. Set `FRONTEND_PORT` in `.env` if port 80 is already in use.

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
docker compose up -d

# Stop containers while preserving database data
docker compose down
```

MySQL data is stored in the named volume `loan_mysql_data`. Back it up regularly using a database-aware backup process and test restores. `docker compose down -v` deletes the database volume and all stored application data; do not use it for routine shutdown or deployment.

The project currently has no versioned database migration system. The schema bootstrap command above is intended for an initial empty database only. For future schema changes on a database containing real data, add and review migrations rather than enabling synchronization against production data.
