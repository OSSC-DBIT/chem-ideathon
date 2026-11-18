# Ideathon '26 Registration

Registration platform for **Ideathon '26**, organised by the Department of Chemistry,
Don Bosco Institute of Technology, Bengaluru, on 28 November 2026.

Built and maintained by [OSSC (OpenSource Students Club), DBIT](https://webuildnow.in).

## What it does

**For students (1st years only)**

- Pick an event, add the team (leader plus members, each with name, roll number and branch), pay by UPI.
- The payment step shows a QR code with the exact amount (Rs. 50 x team size), then asks for the
  12 digit transaction ID and a payment screenshot.
- Every registration gets an ID such as `IDT26-K7M2QX` and starts as "pending".
- A status checker (registration ID plus the leader's phone number) shows pending, confirmed or rejected with the reason.
- Privacy policy at `/privacy`, with a required tick box.
- "Already registered" is shown as soon as a roll number or team name is typed, and checked again before
  the payment step, so nobody pays for a team that cannot register.
- A self hosted image captcha (five digits) on the final step. No outside service is involved.

**For organisers (`/admin`)**

- **Overview**: pending, approved and rejected counts, verified collection, how full each event is.
- **Registrations**: search and filter, open a registration to see the members and the payment screenshot,
  then approve, reject with a reason, or delete.
- **Bank statement**: upload the statement (.xlsx, .csv, .txt) or paste its text. Each pending registration
  is matched by transaction ID and amount; review the result and approve the matches in one click.
- **Events**: add, edit and remove events. Set team or solo, minimum and maximum team size,
  a cap on teams or participants, the fee, and open or close each event.
- **Settings**: open or close registration, or schedule opening and closing times. UPI ID, notice banner,
  branch list, and whether a student may join more than one event.
- **Exports**: Excel, CSV or JSON, one row per team or one row per participant, using the current filters.
- **Activity log**: sign ins, approvals, rejections, exports and setting changes.

## Rules the system enforces

- Team size must be within the event's minimum and maximum.
- An event stops taking entries when its cap is reached (pending and approved entries both hold a slot).
- **One student, one event.** A roll number that is already in a pending or approved registration cannot be
  entered again in any event. (Organisers can relax this under Settings.)
- A transaction ID can be used only once. Team names are unique per event.
- A rejected registration frees its slot, roll numbers and transaction ID so the team can register again.

## Run with Docker

```sh
git clone https://github.com/OSSC-DBIT/chem-ideathon.git
cd chem-ideathon
cp .env.example .env      # set ADMIN_PASSWORD (12+ characters)
docker compose up -d --build
```

The site is on `http://127.0.0.1:8094` on that machine (change `HOST_PORT` in `.env`). It is published
on localhost only; set `HOST_BIND=0.0.0.0` to reach it from other machines without a tunnel.
Sign in at `/admin`, open **Settings**, and set the **UPI ID**. Registrations stay closed until a UPI ID is set.

Deploying on the OSSC server, with the Cloudflare tunnel and the OSSC mail server:
[docs/deploy-ossc-server.md](docs/deploy-ossc-server.md).

Three containers run: `nginx` (the only one published), `app` (Node.js) and `clamav` (virus scanner).
The last two are reachable on the internal network only.

```sh
docker compose logs -f            # logs
docker compose up -d --build      # update after pulling changes
docker compose down               # stop; data stays in the volume
```

### HTTPS

Serve the site over HTTPS in production, because admin logins and student details travel over it.
The usual setup on a shared server is to point the existing HTTPS gateway (Cloudflare Tunnel, nginx, Caddy)
at `http://127.0.0.1:8094` and have it send `X-Forwarded-Proto: https`. The bundled nginx passes that
header on, and the app then marks the admin cookie as secure and sends HSTS.

Behind a Cloudflare tunnel the visitor's address is taken from the `CF-Connecting-IP` header, so rate
limits apply per student and not to the tunnel. That header is trusted from local and private addresses
only, which is why the port is published on `127.0.0.1`. Behind a different gateway, change
`real_ip_header` in `nginx/default.conf` to the header that gateway sets (usually `X-Forwarded-For`).

### Backup

Everything (database and screenshots) is in the `ideathon-data` volume:

```sh
docker compose cp app:/data ./ideathon-backup
```

## Run without Docker

Requires Node.js 22.13 or newer.

```sh
npm install
ADMIN_PASSWORD=some-long-password npm start      # http://localhost:3000
npm test                                          # end to end API check (needs bash and curl)
```

On PowerShell: `$env:ADMIN_PASSWORD = 'some-long-password'; npm start`

## Uploads: limits, cleaning and virus scanning

| Check | Payment screenshot | Bank statement |
| --- | --- | --- |
| File types | JPG, PNG, WebP (checked by file signature, not by name) | .xlsx, .csv, .txt or pasted text |
| Size limit | 10 MB in the browser before resizing; `MAX_SCREENSHOT_MB` (3) on the server | `MAX_STATEMENT_MB` (5) |
| Pixel limits | each side 200 to 10000 px, 40 megapixels in total | not applicable |
| Virus scan | ClamAV, on the bytes exactly as received | ClamAV, before the file is parsed |
| Cleaning | fully decoded and re-saved as a new JPEG of at most 1600 px, so metadata and anything hidden in the file are dropped | read in memory only, never stored |

ClamAV runs as its own container, reachable only by the app. It needs about 1.5 GB of RAM and takes a minute
or so to load after a restart (longer on the very first start, while it downloads virus definitions).

- With `SCAN_REQUIRED=false` (default), uploads that arrive while the scanner is unavailable are still accepted
  and re-encoded, and are marked "not virus scanned" in the admin panel. The Overview tab shows a warning.
- With `SCAN_REQUIRED=true`, uploads are refused until the scanner is back.
- A blocked file is recorded in the activity log with the name of the detection.

To run without virus scanning (for example on a small server), remove the `clamav` service and the
`CLAMAV_HOST` line from `docker-compose.yml`. The other checks stay in place.

## Student list, and proving who is registering

Under **Student list** in the admin panel, upload the 1st year list as Excel or CSV with the columns
**Roll number**, **Name**, **Branch**, and optionally **Phone** and **Email**. Headings are matched loosely
("USN", "Student Name", "Department", "Mobile No" and "Email ID" all work), and a title row above the headings is fine.

| Switch | What it does |
| --- | --- |
| Only students on this list can register | The form asks for roll numbers; name and branch are filled in from the list and cannot be edited. Unknown roll numbers are refused. |
| The team leader must verify their email with a code | A 6 digit code is emailed before payment. With the list on, the code goes to the email the college has for the leader's roll number, so a person cannot register in someone else's name. |
| The leader's phone must match the list | A lighter check, for lists that have phone numbers. |

Only the team leader is verified. Members are added by roll number without their own code, so a verified
leader is the accountable person for the team.

### Email (SMTP)

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` in `.env` (see `.env.example`, which has a
Gmail example), restart, then use **Send test** on the Student list tab. Once email works the site also sends
the leader a message when a registration is received, confirmed or rejected.

Limits on verification emails, all enforced on the server:

- a captcha is needed to request a code, so the form cannot be used to flood someone's inbox
- a code lasts 10 minutes, works once, and allows 5 wrong tries
- resend only after 60 seconds, at most 3 resends per request
- at most 6 emails per address per hour and 12 per day
- per IP limits in nginx (20 a minute) and in the app (40 per 10 minutes), plus `MAIL_DAILY_LIMIT` for the whole site

Emails from a new sender often land in Spam. The form tells students to check there. Sending from a
college domain address, if the college can provide one, gives much better delivery than a free Gmail account.

## Captcha

When email verification is on, the captcha is asked before the code is sent and not again at the end.
Otherwise the final step asks for five digits from an image. The image is drawn on the server, works for one submit
attempt only, and expires after five minutes. It stops scripts from flooding the form; duplicate data is
blocked separately by the registration rules, whether or not a captcha is solved.

## When things go wrong

- Submitting the same registration twice (double tap, or a retry after a dropped connection) returns the
  original registration ID. Nobody is registered or charged twice.
- Slow or lost connections time out with a clear message, and the form keeps everything that was typed.
  Text fields also survive a page refresh.
- If the chosen event fills up or is closed while the form is open, the student is told and sent back to pick another.
- Oversized uploads, rate limits and a restarting server each show a plain message from nginx, not a blank error page.
- An expired admin session returns to the sign in form with a note, and exports report failures on screen.
- The app logs unexpected errors and exits on a fatal one so Docker restarts it (`restart: unless-stopped`).

## Security notes

- Admin password is compared with scrypt in constant time. Sessions are random tokens stored hashed in the
  database, expire after 8 hours, and use HttpOnly, SameSite=Strict cookies.
- Every admin write needs a per session CSRF token, and all writes are checked for same origin.
- Rate limits in nginx and in the app; failed sign ins are limited to 8 per 15 minutes per IP.
- Strict Content Security Policy with no inline scripts or styles and no third party resources (fonts are self hosted).
- Screenshots are resized in the browser, checked by file signature on the server, stored under random
  names outside the web root, and served only to signed in admins.
- All SQL is parameterised. Spreadsheet exports are protected against formula injection.
- Containers run as non root with a read only filesystem, no Linux capabilities and no privilege escalation.
- Uploaded bank statements are processed in memory and never written to disk.

## Project layout

```
server.js               App setup, static files, error handling
src/db.js               SQLite schema, settings, first run event seed
src/security.js         Admin auth, sessions, CSRF, headers, rate limiting
src/public-routes.js    Public info, UPI QR, registration, status check
src/admin-routes.js     Admin API: registrations, events, settings, exports, statement matching
src/reconcile.js        Bank statement parsing and matching
src/export.js           CSV and Excel export
public/                 Frontend (index, admin, privacy, css, js, fonts, images)
nginx/default.conf      Reverse proxy
scripts/smoke-test.sh   End to end API test
```

## Contributing

Contributions are welcome, and first pull requests especially so.

- [CONTRIBUTING.md](CONTRIBUTING.md): set up, tests, and the project rules
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): how we treat each other
- [SECURITY.md](SECURITY.md): how to report a security problem privately
- [AGENTS.md](AGENTS.md): orientation for AI coding agents, and a quick map of the code

## License

[MIT](LICENSE). The event poster, the DBIT name and logos, and the OSSC logo are not covered by the
license and belong to their owners; see [NOTICE.md](NOTICE.md).
