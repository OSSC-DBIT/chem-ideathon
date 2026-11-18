# Configuration

There are two places where the site is configured.

1. **The `.env` file on the server**: secrets and things that need a restart. Described here.
2. **The admin panel**: everything organisers change while the event runs. Described in the
   [Admin guide](admin-guide.md).

After changing `.env`, apply it with `docker compose up -d` (a plain `restart` does not re-read the file).

`.env.example` lists every setting below, in the same groups. `npm test` checks that the code,
`docker-compose.yml`, `.env.example` and this page agree, so a setting cannot be added to one and
forgotten in the others.

## Required

| Variable | What it is |
| --- | --- |
| `ADMIN_PASSWORD` | Password of the owner account. At least 12 characters. |
| `DATA_KEY` | Encryption key for the database and screenshots. At least 32 characters. **Cannot be recovered if lost.** See [Operations](operations.md#the-encryption-key). |

Generate a key:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# or, without Node:
openssl rand -base64 32
```

## Accounts and access

| Variable | Default | What it is |
| --- | --- | --- |
| `ADMIN_USERNAME` | `admin` | Username of the owner account |
| `DATA_KEY_OLD` | empty | Only while changing the key. See [Operations](operations.md#changing-the-encryption-key). |

## Network

| Variable | Default | What it is |
| --- | --- | --- |
| `HOST_PORT` | `8094` | Port on the server that nginx listens on |
| `HOST_BIND` | `127.0.0.1` | Address that port is published on. Leave it, so only the Cloudflare tunnel on the same machine can connect. `0.0.0.0` exposes it to the network. |

`TRUST_PROXY` is set to `1` by Docker Compose, because nginx sits in front of the app. Change it only
if you run the app without the bundled nginx.

## Payment

| Variable | Default | What it is |
| --- | --- | --- |
| `UPI_ID` | empty | Starting value for the UPI ID. The value saved in the admin panel wins once it is set there. |
| `UPI_NAME` | `Ideathon 26` | Starting value for the payee name |

## Email

Leave `SMTP_HOST` empty to run without email. Email verification and status emails then switch off.

| Variable | Default | What it is |
| --- | --- | --- |
| `SMTP_HOST` | empty | Mail server name. Must be the real name on its TLS certificate. |
| `SMTP_PORT` | `587` | 587 for STARTTLS, 465 for TLS from the start |
| `SMTP_USER` | empty | Mailbox login |
| `SMTP_PASS` | empty | Mailbox password |
| `SMTP_SECURE` | empty | `true` for port 465. Empty for 587. |
| `MAIL_FROM` | `SMTP_USER` | Sender, for example `Ideathon 26 <mailbox@webuildnow.in>`. The domain must be one the mail server may send for. |
| `SMTP_ON_THIS_HOST` | empty | Set it to the mail server's name when that server, or a `cloudflared` tunnel to it, runs on this machine. See [Deploying on the OSSC server](deploy-ossc-server.md). |
| `MAIL_DAILY_LIMIT` | `400` | The site stops sending after this many emails in a day |

When a login is used on a port other than 465, the connection must upgrade to TLS (STARTTLS) or
nothing is sent. Passwords never travel unencrypted.

## Uploads and virus scanning

| Variable | Default | What it is |
| --- | --- | --- |
| `MAX_SCREENSHOT_MB` | `3` | Largest payment screenshot the server accepts (after the browser has resized it) |
| `MAX_STATEMENT_MB` | `5` | Largest bank statement or student list file |
| `SCAN_REQUIRED` | `false` | `false`: when the scanner is unavailable, uploads are still accepted, cleaned, and marked "not virus scanned". `true`: uploads are refused until the scanner is back. |

`CLAMAV_HOST` is set to `clamav` by Docker Compose (`CLAMAV_PORT` defaults to 3310). To run without the
virus scanner, remove the `clamav` service and the `CLAMAV_HOST` line from `docker-compose.yml`.

## Rate limits

Per visitor address, counted by the app. nginx has its own limits on top (see `nginx/default.conf`).
A whole campus can share one address, so these are generous for students and strict for sign in.

| Variable | Default | Applies to |
| --- | --- | --- |
| `API_RATE_LIMIT` | `600` per minute | All API calls together |
| `REGISTER_RATE_LIMIT` | `40` per 10 minutes | Submitting a registration |
| `VERIFY_SEND_RATE_LIMIT` | `40` per 10 minutes | Asking for a verification email |

Fixed limits, not configurable: 8 failed sign ins per 15 minutes, 300 captcha images per 10 minutes,
900 roll number checks per 10 minutes, 120 code checks per 10 minutes, 30 status checks per 10 minutes.

## Development only

These are ignored when `NODE_ENV=production`, which the Docker image always sets.

| Variable | Effect |
| --- | --- |
| `CAPTCHA_TEST_CODE` | Five digits that every captcha accepts |
| `MAIL_TEST_FILE` | Emails are written to this file as JSON lines; nothing is sent |
| `DATA_DIR` | Where the database and uploads live (default `./data`) |
| `PORT` | Port the app listens on (default `3000`) |

Without `NODE_ENV=production`, `DATA_KEY` is optional and data is stored unencrypted. That is for
local development only.

## Settings in the admin panel

Stored in the database, changed without a restart.

| Setting | Where | Default |
| --- | --- | --- |
| Registration window: open, closed or scheduled | Settings | Open |
| UPI ID and payee name | Settings | From `.env` |
| Event name, date, contact, notice | Settings | From the poster |
| One student in more than one event | Settings, Rules | Off |
| Branch list (used when the student list is off) | Settings, Rules | CSE, ISE, ECE, EEE, AI & ML, AI & DS, Mechanical, Civil |
| Only listed students can register | Student list | Off until a list is uploaded |
| Leader's phone must match the list | Student list | Off |
| Leader must verify their email | Student list | Off; needs email set up |
| Events: size, limit, fee, open or closed | Events | Five events from the poster |
| Organiser accounts | Settings | None |
