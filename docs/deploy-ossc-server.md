# Deploying on the OSSC server

The site runs on the OSSC server next to PCMS, DBIT PageCraft, OpenQZ and the OSSC website. Visitors
arrive through the server's existing **Cloudflare tunnel**, so no port is opened to the internet, and
email goes out through the server's own mail server.

```
Visitors -> Cloudflare (HTTPS) -> cloudflared on the server -> 127.0.0.1:8094 (nginx) -> app
                                                               app -> mail.webuildnow.in:587 (same machine)
```

## 1. Port

This site uses **8094**, published on `127.0.0.1` only.

Ports already in use on the server (from the PCMS runbook `docs/SERVER.md` and the OpenQZ deploy guide,
November 2026):

| Port | Used by |
| --- | --- |
| 22 | SSH |
| 587 | Mail server |
| 676, 8082 | PCMS staging |
| 677, 8083 | PCMS production |
| 3090, 3091, 8090, 8091 | DBIT PageCraft |
| 4317, 4318 | OpenTelemetry |
| 6001, 6002, 8000 | Coolify |
| 8080 | OSSC website |
| 8081 | in use |
| 8092, 8093 | OpenQZ staging and production |
| 9000, 9443 | Portainer |
| 9090 | Cockpit |
| 20128 | OmniRoute |
| **8094** | **Ideathon '26 (this site)** |

Before the first start, confirm on the server that the port is still free. This must print nothing:

```sh
sudo ss -ltnp | grep -E ':8094 '
```

If it is taken, pick another free port, set `HOST_PORT` in `.env`, and use that port in the Cloudflare
hostname below. Then add this row to the port table in the PCMS repository's `docs/SERVER.md`:

```
| 8094 | Ideathon '26 registration nginx (`ideathon.webuildnow.in`) | tunnel |
```

## 2. Get the code and configure it

```sh
sudo mkdir -p /srv/chem-ideathon && sudo chown "$USER" /srv/chem-ideathon
git clone https://github.com/OSSC-DBIT/chem-ideathon.git /srv/chem-ideathon
cd /srv/chem-ideathon
cp .env.example .env
chmod 600 .env
nano .env
```

Values to set in `.env`:

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<a long password, 12 characters or more>
DATA_KEY=<encryption key, 32 characters or more; generate it as shown below>
HOST_PORT=8094

# Mail: the mail server is on this same machine.
SMTP_HOST=mail.webuildnow.in
SMTP_PORT=587
SMTP_USER=<mailbox login, ask the mail admin>
SMTP_PASS=<mailbox password>
MAIL_FROM=Ideathon 26 <mailbox@webuildnow.in>
SMTP_ON_THIS_HOST=mail.webuildnow.in
```

Generate `DATA_KEY` on the server and **save a copy somewhere else** (a password manager, or a sealed
note with the faculty coordinator). It encrypts the database and every payment screenshot. If it is
lost, the data cannot be read by anyone, and backups are useless without it.

```sh
openssl rand -base64 32
```

Notes on the mail settings:

- `SMTP_HOST` must be the mail server's real name, not `localhost`, because its TLS certificate is
  for `mail.webuildnow.in`. `SMTP_ON_THIS_HOST` makes that name point at the server itself from inside
  the container.
- The sender must be a `webuildnow.in` address. Mail sent as `@dbit.co.in` through this server is
  dropped by Gmail and Outlook, because the college's SPF record allows only Microsoft 365.
- The UPI ID is set later in the admin panel, not here.

## 3. Start it

```sh
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:8094/healthz        # {"ok":true}
```

The virus scanner (`clamav`) takes a minute to load, and a few minutes on the very first start while it
downloads its definitions. It needs about 1.5 GB of RAM.

## 4. Cloudflare hostname

Cloudflare dashboard: **Zero Trust**, **Networks**, **Tunnels**, the server's existing tunnel,
**Public hostname**, **Add**:

| Subdomain | Domain | Type | URL |
| --- | --- | --- | --- |
| `ideathon` | `webuildnow.in` | HTTP | `localhost:8094` |

Plain HTTP on that last hop is fine: TLS ends at Cloudflare. nginx takes the visitor's address from
`CF-Connecting-IP` and the `https` scheme from `X-Forwarded-Proto`, so rate limits are per visitor and
the admin cookie is marked secure.

Recommended for the hostname's zone: SSL/TLS mode **Full**, **Always Use HTTPS** on. Leave **Rocket
Loader** and HTML **minification** off; they inject scripts that the site's Content Security Policy blocks.

## 5. First run checklist in the admin panel

Open `https://ideathon.webuildnow.in/admin` and sign in.

1. **Settings**: set the UPI ID and payee name, and add an organiser account for each person helping.
2. **Student list**: upload the 1st year list (the format and a template are on that page).
3. **Student list**: press **Check connection**, then **Send test** to your own address. Look in Spam too.
4. **Student list**: tick "Only students on this list can register" and "The team leader must verify
   their email with a code".
5. **Events**: check team sizes, limits and fees, and set each event's **half** and **ID code**.
6. **Overview**: make sure there is no warning about the virus scanner or the UPI ID.
7. Register one test team from a phone, approve it, then delete it.

## 6. Day to day

```sh
cd /srv/chem-ideathon
docker compose ps                         # state of the three containers
docker compose logs -f app                # app log (mail and scanner problems show here)
git pull && docker compose up -d --build  # update to the latest code
docker compose restart app                # after editing .env use: docker compose up -d
bash scripts/backup.sh                    # encrypted backup into ./backups/
```

Never run `docker compose down -v`: the `-v` deletes the database and the uploaded screenshots.

Take a backup before the event day and again after registrations close. Backups, restoring, changing
the encryption key and troubleshooting are covered in [Operations](operations.md).

## Running it on a laptop with the real mail server

The mail server does not accept SMTP from outside. It is published through Cloudflare as
`smtp-tunnel.webuildnow.in`, and `cloudflared` on the laptop turns that into a local port.

1. Install cloudflared (`winget install --id Cloudflare.cloudflared` on Windows).
2. Keep this running in its own terminal:

   ```sh
   cloudflared access tcp --hostname smtp-tunnel.webuildnow.in --url localhost:1587
   ```

   On Linux use `--url 0.0.0.0:1587` (containers cannot reach a port bound to localhost there) and
   block port 1587 in the firewall.
3. In `.env` use the same mail settings as above, but with `SMTP_PORT=1587`.
4. `docker compose up -d`, then **Check connection** on the Student list tab.

Without the tunnel running, Check connection reports that the mail server did not answer.
