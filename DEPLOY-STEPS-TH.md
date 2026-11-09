# คู่มือ Deploy ขึ้น Production ทีละขั้น (Ubuntu + Docker + Kong)

เอกสารนี้เป็น runbook สำหรับพิมพ์ตามได้ทันที เรียงเป็นขั้น 0 → 16 พร้อมจุดตรวจ (checkpoint) ทุกขั้น
สาเหตุเชิงออกแบบของแต่ละการเลือกอยู่ที่ [DEPLOYMENT_UBUNTU.md](DEPLOYMENT_UBUNTU.md) และ
[scripts/gateway/README.md](scripts/gateway/README.md) — ถ้าสองไฟล์ขัดกัน ให้ยึดไฟล์ compose จริงเป็นความจริง

สิ่งที่ได้หลังจบคู่มือ: เว็บ + API + MySQL + Kafka/mailer + Kong อยู่ในกลุ่ม container เดียวกัน
โดยมี Kong เป็น พัอร์ทสาธารณะเดียว (80/443), schema มาจาก migration, และไม่มีข้อมูลตัวอย่างปนในเล่ม

---

## 0. ข้อกำหนดล่วงหน้า

| หัวข้อ | ค่า |
| --- | --- |
| OS | Ubuntu Server 22.04 หรือ 24.04 LTS |
| RAM | อย่างน้อย 8 GB (เพดานที่ `docker-compose.prod.yml` ตั้งไว้ทั้งกลุ่มรวมกันประมาณ 6.1 GiB) |
| Disk | 40 GB ขึ้นไป (image + volume MySQL/Kafka/Kong Postgres + log ที่ rotate) |
| Domain | ชี้ A record มาที่เครื่องนี้ ก่อนขั้น 10 (TLS) |
| สิทธิ์ | ผู้ใช้ที่เพิ่มเข้ากลุ่ม `docker` และ `sudo` สำหรับขั้น firewall เท่านั้น |
| เวลา | ครั้งแรกประมาณ 45–60 นาที (build นานที่สุด) |

ตัวแปรที่ใช้อ้างทั้งเอกสาร (ตั้งก่อนเริ่ม แล้ว export ไว้ใน shell เดียวกัน):

```bash
export APP_DIR=/opt/loan-management-system
export DOMAIN=loan.example.com          # ไม่ต้องมี https://
```

---

## 1. เตรียมเครื่อง Ubuntu

ติดตั้ง Docker Engine + Compose plugin ตามขั้นตอนอย่างเป็นทางการของ Docker
<https://docs.docker.com/engine/install/ubuntu/> แล้วตรวจ:

```bash
docker --version
docker compose version          # ต้องเป็น "Docker Compose version v2.x"
sudo usermod -aG docker "$USER" && newgrp docker
```

**จุดตรวจ:** `docker ps` ต้องรันได้โดยไม่ขึ้นคำว่า permission denied

---

## 2. ปิดพอร์ตที่ยังไม่จำเป็นก่อนเปิดใช้

Kong เป็น entry point เดียว ดังนั้นมีเพียง 3 พอร์ตที่ต้องเปิดรับจากภายนอก:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

ห้ามเปิด 3307 (MySQL), 9094 (Kafka), 8001 (Kong Admin) ให้ภายนอก — ในไฟล์ prod พอร์ตเหล่านี้
ไม่ถูก publish เลยหรือ map เข้า `127.0.0.1` เท่านั้น ถ้ามี rule เก่าจากเครื่อง dev ให้ `sudo ufw delete`

---

## 3. เอาโค้ดลงเครื่อง

```bash
sudo mkdir -p /opt && sudo chown "$USER" /opt
cd /opt
git clone <repository-url> loan-management-system
cd "$APP_DIR"
git log -1 --oneline                 # บันทึก commit ที่ deploy ไว้ใน ticket
```

> **ต้อง commit และ push ก่อน deploy** — ไฟล์ของ stack ผลิต (`docker-compose.prod.yml`,
> `scripts/gateway/*.sh`, `web/nginx.prod.conf`, `web/Dockerfile`) ยังไม่อยู่ใน git ของ repo นี้
> ถ้ายังไม่พร้อม commit ให้ copy ทั้งโฟลเดอร์ขึ้นไปเครื่อง server แทนการ `git clone`

ทำให้ script ของ gateway รันได้จริงหลัง clone (git อาจเก็บ mode เป็น non-executable):

```bash
chmod +x "$APP_DIR"/scripts/gateway/*.sh
./scripts/gateway/status.sh --help   # ต้องพิมพ์ usage ได้ ไม่ขึ้น permission denied
```

---

## 4. สร้าง `.env` (ขั้นที่พลาดแล้วระบบไม่ขึ้น)

`.env` ของ stack ผลิตถูก compose อ่านอัตโนมัติ ไฟล์ตัวอย่างอยู่ที่ `.env.example` (126 บรรทัด)

```bash
cp .env.example .env
chmod 600 .env
```

ตัวแปร 7 ตัวนี้ **บังคับ** ( compose ใช้ไวยากรณ์ `${VAR:?}` — ถ้าว่าง container จะไม่สร้าง ):

| ตัวแปร | สร้างด้วย | หมายเหตุ |
| --- | --- | --- |
| `MYSQL_ROOT_PASSWORD` | `openssl rand -hex 32` | root ของ MySQL เท่านั้น แอปใช้ `DB_USER` |
| `DB_PASSWORD` | `openssl rand -hex 32` | ต้องต่างจากตัวบน |
| `JWT_SECRET` | `openssl rand -hex 32` | เปลี่ยนเมื่อไหร่ token ทุกตัวตายทันที |
| `KONG_PG_PASSWORD` | `openssl rand -hex 32` | ฐานข้อมูลของ Kong เอง |
| `NOTIFY_SECRET_KEY` | `openssl rand -hex 32` | กุญก์ seal ความลับใน outbox (OTP/reset link) — ห้ามใช้ค่าซ้ำที่อื่น |
| `MAILER_API_KEY` | `openssl rand -hex 32` | backend ↔ mailer ต้องตรงกัน |
| `WEB_PUBLIC_URL` | พิมพ์เอง | origin เต็มรัปแบ่ง ที่ผู้ใช้เห็น เช่น `https://loan.example.com` — ลิงก์ในอีเมลสร้างจากค่านี้ |

ตัวแปรที่ควรตรวจก่อนกดเริ่ม (ค่า default ในไฟล์อย่างอื่นใช้ได้):

```bash
SEED_ON_BOOT=false        # compose override เป็น false อยู่แล้ว (backend + db-migrate)
DB_SYNCHRONIZE=false      # compose override เป็น false เช่นกัน — schema มาจาก migration เท่านั้น
NOTIFY_ENABLED=true
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / MAIL_FROM   # ไม่งั้นอีเมลไม่ออก (transport เป็น kafka)
AUTO_DEBIT_ENABLED=false  # ระบบตัดเงินอัตโนมัติ: ปิดไว้ก่อน แล้วค่อยเปิดจากหน้าจอ ADMIN เมื่อพร้อม
COLLATERAL_MIN_COVERAGE_PERCENT=100
KONG_HTTPS_PORT=8443      # เปลี่ยนเป็น 443 ในขั้น 10 เท่านั้น
```

**จุดตรวจ:**

```bash
grep -c 'REPLACE_WITH' .env      # ต้องได้ 0
stat -c '%a %n' .env             # ต้องได้ 600
git check-ignore -v .env         # ต้องบอกว่า .gitignore กันไว้
```

---

## 5. Build image

```bash
cd "$APP_DIR"
docker compose -f docker-compose.prod.yml build 2>&1 | tail -20
```

สร้าง 3 images: `loan-ms/backend:prod`, `loan-ms/mailer:prod`, `loan-ms/web:prod`
(เว็บใช้ `web/nginx.prod.conf` = static เท่านั้น เพราะ `/api` เป็นหน้าที่ Kong)

ถ้าต้องการ tag ตามรุ่นเพื่อ rollback ภายหลัง ให้ระบุ `IMAGE_TAG` ทั้งตอน build และตอน up:

```bash
export IMAGE_TAG=2026-10-16
docker compose -f docker-compose.prod.yml build
```

---

## 6. เปิด stack ครั้งแรก (migration รันเอง)

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

ลำดับที่ compose จัดให้เอง: `mysql` healthy → `db-migrate` รัน `server/src/migrations` จนจบแบบ exit 0
→ `backend` ค่อย start → `kong-postgres` healthy → `kong-migrations` → `kong`
`frontend` และ `mailer` เป็น worker ที่ค้างอยู่ในกลุ่มเดียวกัน

**จุดตรวจ 1 — migration ครบทั้ง 4 ตัว:**

```bash
docker compose -f docker-compose.prod.yml logs db-migrate | tail -5
```

ต้องเห็นบรรทัด `... has been executed successfully.` ต่อด้วย `COMMIT`
(ครั้งแรกจะรัน `BaselineSchema` ซึ่งสร้างตารางทั้งหมดของระบบ)

**จุดตรวจ 2 — ทุก container มี status healthy/running:**

```bash
docker compose -f docker-compose.prod.yml ps --format '{{.Name}}\t{{.Status}}'
```

**เมื่อ one-shot ล้ม** (เห็น `Exited (1)` ที่ `db-migrate` หรือ `kong-migrations`):

```bash
docker compose -f docker-compose.prod.yml logs db-migrate | tail -40   # อ่านสาเหตุก่อน
docker compose -f docker-compose.prod.yml run --rm db-migrate          # แก้เสร็จแล้วรันซ้ำ (idempotent)
docker compose -f docker-compose.prod.yml run --rm kong-migrations
```

---

## 7. ตั้งสายให้ Kong (services / routes / plugins)

สคริปต์เป็น bash + curl ล้วน ต้องรัน **บน host** เพราะ Admin API map ไว้ที่ `127.0.0.1:8001` เท่านั้น

```bash
KONG_DRY_RUN=true ./scripts/gateway/bootstrap.sh   # ดู JSON bodies ก่อนโดยไม่เขียนอะไร
./scripts/gateway/bootstrap.sh
./scripts/gateway/status.sh
```

สิ่งที่ `bootstrap.sh` สร้าง (รันซ้ำได้ — ทุก object ถูกค้นหาด้วยชื่อแล้ว PATCH):

| object | ค่า | เหตุผล |
| --- | --- | --- |
| service `loan-web` → route `/` | `frontend:80` | static React; SPA fallback อยู่ที่ nginx ของ container |
| service `loan-api` → route `/api` | `backend:4000`, `strip_path=false` | Express mount router ใต้ `/api` อยู่แล้ว |
| plugin `rate-limiting` (global) | 20 req/s, 600 req/min ต่อ client IP | กัน brute-force ที่ edge |
| plugin `request-size-limiting` (global) | 10 MiB | ไฟล์ KYC ใหญ่เกินไม่ควรหลุดถึง Node |
| plugin `cors` | **ปิดไว้ default** | อย่าเปิด: `app.ts` ตอบ `Access-Control-Allow-Origin: *` อยู่แล้ว ได้ ACAO ซ้อนสองตัว browser ปฏิเสธทั้ง response |

ปรับค่าผ่าน `KONG_*` ใน `.env` (สคริปต์อ่านเฉพาะบรรทัด `KONG_*` ไม่ได้ source ทั้งไฟล์)

---

## 8. ตรวจรับจากภายนอก

```bash
curl -i http://$DOMAIN/                    # 200 + HTML ของ React
curl -i http://$DOMAIN/api/auth/me         # 401 JSON = ลอด Kong ถึง Express แล้ว
curl -i http://$DOMAIN/manual              # 200 = SPA fallback ยังทำงานผ่าน Kong
curl -s http://localhost:8001/status | head -20
```

| อาการ | ความหมาย | ต้องดูอะไร |
| --- | --- | --- |
| `502` / `503` ที่ `/` หรือ `/api` | Kong เข้าถึง container ปลายทางไม่ได้ | `frontend`/`backend` อยู่บน network `edge` ไหม (`docker inspect --format '{{json .NetworkSettings.Networks}}' loan-ms-prod-backend-1`) |
| `404` ที่ `/api/...` | route ถูกลบ หรือ `strip_path` ถูกเปลี่ยน | `./scripts/gateway/status.sh` |
| `429` | rate limiter ของ Kong | เพิ่ม `KONG_RATE_LIMIT_SECOND` แล้วรัน `bootstrap.sh` ซ้ำ |
| `401` ที่ `/api/auth/me` | **ถูกต้อง** — ยังไม่ล็อกอิน | — |

---

## 9. สร้างผู้ดูแลคนแรก (ไม่มี endpoint ให้สร้างก่อนมี ADMIN)

ระบบไม่มี CLI สร้าง user และ `POST /api/users` ต้องใช้ token ADMIN อยู่แล้ว ดังนั้นครั้งแรกต้อง insert ผ่าน SQL:

```bash
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD   # พิมพ์รหัสผ่าน ไม่ต้องโชว์บนจอ
docker compose -f docker-compose.prod.yml exec -e ADMIN_PASSWORD backend \
  node -p "require('bcryptjs').hashSync(process.env.ADMIN_PASSWORD, 10)"
unset ADMIN_PASSWORD                               # เก็บค่า hash ที่พิมพ์ออกมาไว้ใช้บรรทัดล่าง
```

จากนั้น insert (แทนที่ `<HASH>` ด้วยค่าที่ได้ และเปลี่ยนอีเมล/ชื่อให้จริง):

```bash
docker compose -f docker-compose.prod.yml exec -i mysql \
  sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' <<'SQL'
INSERT INTO users (id, username, passwordHash, fullName, email, isEmailVerified, role, isActive)
VALUES (UUID(), 'admin', '<HASH>', 'ผู้ดูแลระบบ', 'admin@example.com', 1, 'ADMIN', 1);
SELECT username, role, isActive FROM users;
SQL
```

ข้อควรรู้:
- `bcryptjs` cost 10 คือค่าเดียวกับที่ `users.router.ts` ใช้ — hash ที่สร้างคนละ cost ยัง login ได้
- รหัสผ่านควรผ่านนโยบายที่ตั้งไว้ใน `.env` (`PASSWORD_MIN_LENGTH` และ `PASSWORD_REQUIRE_DIGIT` /
  `PASSWORD_REQUIRE_UPPERCASE` / `PASSWORD_REQUIRE_LOWERCASE`) เพราะการตรวจนโยบายเกิดขึ้น
  ตอนเปลี่ยนรหัสผ่านครั้งถัดไป ไม่ใช่ตอน insert
- users รายอื่น (HEAD_APPROVER / CHECKER / MAKER / VIEWER) สร้างจากหน้าจอ **User management** ได้เลย
- เทมเพลตอีเมลถูก seed อัตโนมัติทุกครั้งที่บูต แต่ seed เฉพาะ locale `lo` (`TEMPLATE_LOCALE`)
  สำหรับทุก event ใน `DEFAULT_TEMPLATES` — ถ้าต้องการสำเนาภาษาอังกฤษ (`en`) ต้องเขียนเพิ่มเอง
  ตรวจด้วย `SELECT code, locale FROM email_templates ORDER BY code;`

ล็อกอินที่ `https://$DOMAIN` แล้ว **เปลี่ยนรหัสผ่านของ admin ทันที** (Profile → เปลี่ยนรหัสผ่าน)
เพื่อให้ `passwordChangedAt` เดินเวลาและ session เก่าถูกตัด (การตัด session แม่นระดับมิลลิวินาที)

---

## 10. TLS (ขั้นนี้ต้องรันตอน traffic ยังน้อย)

Kong เป็นผู้จบ TLS ให้เอง (terminate) ไม่ต้องวาง Caddy/Nginx ซ้อนหน้า

```bash
# 1) ขอใบรับรอง (Kong ปิดชั่วคราวเพราะ certbot ยึดพอร์ต 80)
docker compose -f docker-compose.prod.yml stop kong
sudo certbot certonly --standalone -d $DOMAIN
docker compose -f docker-compose.prod.yml start kong

# 2) คัดลอก cert เข้ามาใน project
sudo mkdir -p "$APP_DIR/certs"
sudo cp /etc/letsencrypt/live/$DOMAIN/fullchain.pem /etc/letsencrypt/live/$DOMAIN/privkey.pem "$APP_DIR/certs/"
sudo chown -R "$USER":"$USER" "$APP_DIR/certs" && chmod 700 "$APP_DIR/certs"
echo "certs/" >> .gitignore        # กัน private key หลุดเข้า git
```

แก้ `docker-compose.prod.yml` สองจุด (อย่าเพิ่ม `environment:` blocks ซ้ำใน `services.kong` —
service นี้รับ env จาก anchor `x-kong-env` อยู่แล้ว การใส่คีย์สองครั้งทำให้ YAML พัง):

```yaml
# 1) บล็อกบนสุดของไฟล์: x-kong-env: &kong-env — ต่อท้ายรายการเดิม
  KONG_PROXY_LISTEN: "0.0.0.0:8000, 0.0.0.0:8443 ssl http2"
  KONG_SSL_CERT: /etc/kong/certs/fullchain.pem
  KONG_SSL_CERT_KEY: /etc/kong/certs/privkey.pem

# 2) services.kong — เพิ่ม volumes (ports มี 8443 อยู่แล้ว ไม่ต้องแก้)
    volumes:
      - ./certs:/etc/kong/certs:ro
```

`kong-migrations` ใช้ anchor เดียวกันด้วย จึงได้ตัวแปรสามตัวนี้ไปเช่นกัน แต่ไม่มีผลอะไร
เพราะ one-shot นี้ไม่ได้ฟังพอร์ต

ตั้ง `.env` แล้ว restart เฉพาะ kong:

```bash
sed -i 's/^KONG_HTTPS_PORT=.*/KONG_HTTPS_PORT=443/' .env
sed -i "s|^WEB_PUBLIC_URL=.*|WEB_PUBLIC_URL=https://$DOMAIN|" .env
docker compose -f docker-compose.prod.yml up -d kong backend
./scripts/gateway/status.sh
```

ต่ออายุอัตโนมัติ (certbot ต่ออายุใน path ที่ Kong ยึด 80 อยู่แล้วไม่ได้) ให้ใช้ hook ที่หยุด/เริ่ม container:

```bash
sudo tee /etc/letsencrypt/renewal-hooks/deploy/loan-ms-kong.sh > /dev/null <<'SH'
#!/usr/bin/env bash
set -e
cp /etc/letsencrypt/live/loan.example.com/fullchain.pem /etc/letsencrypt/live/loan.example.com/privkey.pem /opt/loan-management-system/certs/
docker compose -f /opt/loan-management-system/docker-compose.prod.yml restart kong
SH
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/loan-ms-kong.sh
sudo certbot renew --dry-run
```

**จุดตรวจ:** `curl -I https://$DOMAIN` ได้ 200, `curl -I http://$DOMAIN` redirect หรือ serving อยู่ (Kong ยังฟัง 80),
และล็อกเข้าระบบแล้วลิงก์ "ลืมรหัสผ่าน" ในอีเมลเปิดด้วย `https://$DOMAIN` ไม่ใช่ `http://localhost`

---

## 11. ตั้งค่านโยบายระบบก่อนให้ทีมงานใช้

ทำจากหน้าจอ ADMIN (ค่าเหล่านี้เก็บในตาราง `system_config` แก้ทีหลังได้โดยไม่ต้อง restart):

| เมนู | ค่าเริ่มต้นที่ควรตรวจ |
| --- | --- |
| Approval thresholds | `checkerThreshold` / `headThreshold` เป็นบาทจริง — ทุกเอกสารทางการเงินและบันทึกแก้ไขสัญญาใช้สองชั้นนี้ |
| KYC policy | บังคับ VERIFIED ก่อนปล่อยกู้; `expiryWarningDays=0` = ปิดการเตือน (0 มีความหมายจริง) |
| Password / Avatar policy | ความยาว, ตัวเลข/ตัวใหญ่/ตัวเล็ก/อักขระพิเศษ, ขนาดไฟล์ |
| Collateral policy | `minCoveragePercent`, `maxValuationAgeDays`, `requirePledgeForRestructure` (เพดาน 1000% / 3650 วัน) |
| Collection / auto-debit | `autoDebitEnabled` ควร **ปิด** จนกว่าจะยืนยันกระแสวิ่งจริง; lead days 3 |
| Email templates | ระบบ seed เฉพาะ `lo` ให้เอง; เขียนสำเนา `en` เพิ่มแล้วตรวจ `{{variable}}` ก่อนส่งจริง |
| Products | ดอกเบี้ย FLAT หรือ DECLINING ต่อผลิตภัณฑ์, นโยบายค่าปรับ, ค่าปรับปิดหนี้ก่อนครบสัญญา |

---

## 12. Backup ทั้งสองฐานข้อมูล (คนละ engine)

ระบบมีฐานข้อมูลสองตัว: MySQL (ข้อมูลธุรกิจ) และ Postgres (การตั้งค่า Kong) — backup ไม่ครบตัวหลัง
หมายความว่า restore แล้วต้องมานั่งรัน `bootstrap.sh` ใหม่ (ซึ่งรันได้แต่ต้องรู้ตัว)

```bash
sudo mkdir -p /var/backups/loan-ms && sudo chown "$USER" /var/backups/loan-ms
cat > "$APP_DIR/scripts/backup-prod.sh" <<'SH'
#!/usr/bin/env bash
# คืนละครั้ง: mysqldump + pg_dump ของ Kong, เก็บ 14 วัน, ไฟล์ละ ~0.1-1 GB
set -euo pipefail
cd "$(dirname "$0")/.."
STAMP=$(date +%F_%H%M)
DEST=${DEST:-/var/backups/loan-ms}
COMPOSE=(docker compose -f docker-compose.prod.yml)
"${COMPOSE[@]}" exec -T mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --set-gtid-purged=OFF "$MYSQL_DATABASE"' \
  > "$DEST/loan_ms_$STAMP.sql"
"${COMPOSE[@]}" exec -T kong-postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$DEST/kong_$STAMP.sql"
gzip -f "$DEST"/*.sql
find "$DEST" -name '*.sql.gz' -mtime +14 -delete
echo "backup ok -> $DEST"
SH
chmod +x "$APP_DIR/scripts/backup-prod.sh"
./scripts/backup-prod.sh
```

หมายเหตุ: `MYSQL_ROOT_PASSWORD`, `MYSQL_DATABASE`, `POSTGRES_USER`, `POSTGRES_DB` เป็น environment
ของ container อยู่นแล้ว (compose ใส่ให้จาก `.env`) คำสั่ง dump จึงอ่านค่าข้างใน container ทั้งหมด
และรหัสผ่านไม่ไปโผล่บน command line ของ host

ตั้ง cron:

```bash
( crontab -l 2>/dev/null; echo '20 2 * * * /opt/loan-management-system/scripts/backup-prod.sh >> /var/backups/loan-ms/backup.log 2>&1' ) | crontab -
```

**ทดสอบ restore ทุกเดือน** (backup ที่ยังไม่เคย restore คือความหวัง ไม่ใช่ backup) — วิธีทำเต็มอยู่ใน
DEPLOYMENT_UBUNTU.md หัวข้อ *Restore rehearsal*: dump ลง schema ทดสอบ `loan_ms_restore_probe`
แล้วนับ `financial_transactions` เทียบกับตัวจริงให้เท่ากัน และ `npm run db:migrate` ต้องรายงาน
`No migrations are pending`

---

## 13. Upgrade รุ่น / Rollback

```bash
cd "$APP_DIR"
./scripts/backup-prod.sh                          # 1) backup ก่อนแตะอะไรเสมอ
git fetch && git log --oneline HEAD..origin/main  # 2) ดูว่ามี migration ใหม่ไหม
git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d   # db-migrate รันอีกครั้ง ก่อน backend restart
./scripts/gateway/status.sh                       # 3) เท่าเดิม ถ้าไม่ได้แก้ routing
```

- `db-migrate` เป็น one-shot ที่ compose รอให้จบก่อนเสมอ จึงไม่มีจังหวะที่ API เทรฟิกชน schema เก่า
- ถ้า release นั้นมี migration ที่แก้คอลัมน์ใหญ่ ให้อ่าน SQL ในไฟล์ migration ก่อน (enum ที่ generate มาเป็น
  `DROP/ADD COLUMN` ต้องแก้เป็น `MODIFY COLUMN` ไม่งั้นข้อมูลคอลัมน์นั้นทั้งตารางจะกลายเป็นค่าแรกของ enum)
- **Rollback code:** `IMAGE_TAG=<รุ่นเก่า> docker compose -f docker-compose.prod.yml up -d`
  (ต้องเคย build ด้วย tag นั้นไว้ — migration ที่ apply ไปแล้ว **ไม่ย้อน** ให้ออกแบบให้ additive)
- **Rollback ข้อมูล:** restore จาก `loan_ms_*.sql.gz` เท่านั้น ห้ามใช้ `down -v` (ลบทั้ง 5 volumes)

---

## 14. Log, disk, และสุขภาพระบบ

```bash
docker compose -f docker-compose.prod.yml ps                      # ทุกตัวต้อง healthy
docker compose -f docker-compose.prod.yml logs -f --tail=100 backend kong
docker compose -f docker-compose.prod.yml exec backend sh -c 'ls -lh server/dist/logs | tail -5'
df -h /var/lib/docker
```

- Log ของ container ถูก rotate ที่ `LOG_MAX_SIZE`/`LOG_MAX_FILES` (default 10 MB × 5 ต่อ service)
  แต่ `.env.example` ตั้งชื่อผิดเป็น `LOG_MAX_FILE` (ไม่มี S) — compose จะมองไม่เห็นค่าที่พิมพ์ไว้
  ให้แก้เป็น `LOG_MAX_FILES` ใน `.env` เอง (ไฟล์นี้ไม่ได้ถูก git กันไว้ จึงแก้ได้ตามชอบ)
- Log ของแอป (winston) เป็นไฟล์รายชั่วโมงใน volume `loan_backend_logs` — เก็บ 7 วันแล้วลบเองไม่ได้
  ต้องตั้ง cron ลบเอง: `find` ใน volume หรือ mount ออกมาที่ host
- **ห้าม grep OTP/รหัสผ่านใน log ไปเปิดต่อสาธารณะ**: ถ้าต้องแชร์ log ให้รัน
  `npm run logs:scrub` (รายงาน) แล้ว `npm run logs:scrub:apply` (redact เป็น `<redacted>`)
- `GET /health` ใช้เป็น external uptime check ได้ (ไม่แตะ DB writes)

---

## 15. Checklist ก่อนกดเปิดใช้จริง

- [ ] `.env` ไม่มีค่า `REPLACE_WITH` เหลือ, chmod 600, และ `.gitignore` กันไว้ (รวม `certs/`)
- [ ] `ufw status` มีเฉพาะ OpenSSH/80/443 — ไม่มี 3307, 9094, 8001
- [ ] `db:migrate:status` รายงาน `[X]` ครบทุกตัวและ `No migrations are pending`
- [ ] `./scripts/gateway/status.sh` มี `loan-web`, `loan-api`, rate-limiting, request-size-limiting และ **ไม่มี** cors plugin
- [ ] `SEED_ON_BOOT=false`, `DB_SYNCHRONIZE=false` (compose pin ไว้ — อย่าไปแก้)
- [ ] เข้าระบบด้วย admin แล้วยืนยันว่า demo data ไม่มี ( `SELECT COUNT(*) FROM customers;` = 0)
- [ ] ล็อกอินจริง 1 บัญชี + view dashboard + ทำ 1 อนุมัติ maker-checker สมบูรณ์
- [ ] อีเมล "ลืมรหัสผ่าน" ออกจริงและลิงก์เป็น `https://$DOMAIN`
- [ ] backup คืนก่อนหน้ามีไฟล์จริง + เคยทดสอบ restore สำเร็จ
- [ ] ทราบข้อค้าง 2 ข้อของโค้ด production: (1) `app.ts` ไม่มี `app.set('trust proxy', 1)` → IP ใน audit
      และ throttle ลืมรหัสผ่านจะนับ Kong ทั้งเครื่องเป็น client เดียว (2) `cors()` ยังตอบ `*` ไม่มี allow-list
      ทั้งสองข้ออยู่ใน DEPLOYMENT_UBUNTU.md หัวข้อ *Two production gaps* — ยังไม่ได้แก้อาณัติโค้ดระบบ

---

## 16. แก้เหตุขัดข้องที่เจอบ่อย

| อาการ | สาเหตุ | ทางแก้ |
| --- | --- | --- |
| boot ล้ม `Data truncated for column 'code' at row 1` | migration ค้างยังไม่ได้ apply (enum ของ `email_templates` ไม่รับ event ใหม่) | `docker compose -f docker-compose.prod.yml run --rm db-migrate` แล้ว up ใหม่ |
| `backend` restart loop | stack ของ error ไม่ถูกเขียนลงไฟล์ log (แจ้งไว้เป็น F-LOG) ทำให้เห็นเฉพาะบรรทัด message | อ่าน message บนบรรทัด error ประกอบกับ log ของ one-shot `db-migrate` |
| `kong` ไม่ขึ้น `Kong migrations are not bootstrapped` | one-shot `kong-migrations` ล้ม | `run --rm kong-migrations` |
| `Error: Cannot find module ...` ตอนรัน `npm run db:migrate` บน host | คำสั่งอ่านจาก `dist/` ไม่ใช่ `src/` | `npm run build -w server` ก่อนเสมอ |
| login ได้แต่ refresh แล้ว 401 บ่อย | session ถูกตัดเพราะ `passwordChangedAt` เดินทีหลัง token | เป็นพฤติกรรมตั้งใจ (F-SES-1) —ให้ผู้ใช้อยู่ต่อเมื่อไม่เปลี่ยนรหัสผ่าน |
| ขอ OTP ซ้ำแล้ว 429 `throttled` | cooldown 60s ต่อ IP + โทเคนเก่าถูกนับหมด | รอสลับบัญชี; บน production ที่ไม่มี trust proxy ทุก user นับรวมกัน (ข้อ 1 ด้านบน) |
| e2e suite ชน `429` | rate limiter ของ Kong ตีสัดส่วน request สูงของ suite | รัน suite กับ `docker-compose.yml` (dev) หรือ `bootstrap.sh --no-plugins` |
| `docker compose down -v`ไปแล้วข้อมูลหายหมด | เจตนา — `-v` ลบทั้ง 5 volumes | restore จาก backup; ห้ามใช้ `-v` ตอน deploy ปกติ |

---

ทวนคำสั่งทั้งหมดเป็นย่อหน้าเดียว (สำหรับคนที่เคยรันแล้ว):

```bash
git pull && docker compose -f docker-compose.prod.yml build \
 && docker compose -f docker-compose.prod.yml up -d \
 && ./scripts/gateway/bootstrap.sh && ./scripts/gateway/status.sh
```
