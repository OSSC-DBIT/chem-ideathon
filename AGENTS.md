# AGENTS.md

Guidance for AI coding agents working in this repository, and a fast orientation for people.
Longer explanations live in [docs/](docs/README.md); this file is the short list of what to know
before changing anything.

## What this is

The registration site for Ideathon '26, a one day event of the Department of Chemistry at Don Bosco
Institute of Technology, for 1st year students. It is maintained by OSSC and runs on the OSSC server
behind a Cloudflare tunnel.

How it works, end to end:

1. Organisers upload the 1st year **student list**. Only roll numbers on it can register.
2. A **team leader** picks one event, adds the team by roll number (names fill in from the list),
   and proves who they are with a **code emailed** to the address on the list.
3. The leader pays by UPI and uploads the **transaction ID and a screenshot**.
4. Organisers **verify the payment** against the bank statement and approve or reject.
5. Organisers can also **add a registration by hand** and **edit teams**.

The site holds real student data. Everything on disk is encrypted, and every admin action is logged.

## Commands

| Task | Command |
| --- | --- |
| Install | `npm install` |
| Run for development | `ADMIN_PASSWORD=dev-password UPI_ID=test@upi CAPTCHA_TEST_CODE=24680 MAIL_TEST_FILE=./data/mails.jsonl npm run dev` |
| Run all tests | `npm test` (bash and curl needed; about two minutes) |
| Only the settings check | `node scripts/check-config.mjs` |
| Only the API tests | `bash scripts/smoke-test.sh` |
| Syntax check one file | `node --check src/public-routes.js` |
| Full stack | `docker compose up -d --build` (site on http://127.0.0.1:8094) |
| Backup, restore | `bash scripts/backup.sh`, `bash scripts/restore.sh <folder>` |

In development the site is on http://localhost:3000, the admin panel is `/admin` (username `admin`),
every captcha accepts `24680`, and emails are written to the file instead of being sent.

There is no build step, no bundler, no TypeScript and no linter. The browser runs the files in
`public/` as they are.

## Layout

```
server.js                 Express app: security headers, routers, static files, error handler

src/db.js                 Opens the encrypted SQLite database (converting a plain or old-key one), schema,
                          settings store, addColumn() migrations, first run event seed
src/vault.js              Keys derived from DATA_KEY; sealFile() and openFile() for files on disk
src/security.js           Owner and organiser accounts, sessions, CSRF, security headers, rate limiter
src/rules.js              Input rules shared by public and admin code: roll, phone, email, transaction ID, newCode()

src/public-routes.js      /api/public, /qr, /captcha, /precheck, /verify/send, /verify/check, /register, /status
src/admin-routes.js       /api/admin/*: sign in, registrations, decisions, exports, statement matching, events,
                          student list import, mail checks, organiser accounts, settings, overview, activity log
src/admin-teams.js        /api/admin/*: add a registration by hand, edit a team, add or edit one student

src/uploads.js            Upload limits, image re-encoding (sharp), ClamAV scan
src/captcha.js            Self hosted image captcha, drawn from strokes
src/roster.js             Student list import (xlsx, csv), lookup, maskName() and maskEmail()
src/mailer.js             SMTP sending, email templates with inline banner and logo
src/verify.js             Email verification codes and tokens (in memory)
src/reconcile.js          Bank statement parsing and matching
src/export.js             CSV and Excel export

public/index.html         Public page; js/site.js is its script (the four step registration form)
public/admin.html         Admin panel; js/admin.js is its script (tabs, team editor, student editor)
public/js/ui.js           Shared helpers: el(), api(), download(), toast, confirmBox, busy
public/css/app.css        All styles (neobrutalist design tokens at the top)
public/privacy.html       Privacy policy
public/img/               Poster art, DBIT header, OSSC logo, and the email sized copies (mail-*.jpg)

scripts/check-config.mjs      Settings are consistent across code, compose file, .env.example and docs
scripts/smoke-test.sh         End to end API tests (about 170 checks)
scripts/encryption-test.sh    Encryption across restarts: convert, wrong key, key change
scripts/backup.sh, restore.sh Encrypted backup, and restore with correct file ownership
scripts/make-test-image.mjs   Test images for the API tests

docs/                     Student guide, admin guide, deploy, operations, configuration, security,
                          architecture, API reference, testing
nginx/default.conf        Reverse proxy: rate limits, visitor address from CF-Connecting-IP, friendly errors
docker-compose.yml        app (Node), nginx, clamav. Only nginx is published, on 127.0.0.1:8094
.github/                  CI, Dependabot, issue and pull request templates
```

## Data model in one glance

| Table | Holds |
| --- | --- |
| `events` | Title, team or solo, min and max size, limit, fee, open, order, archived |
| `registrations` | Code, event, team name, leader email and phone, size, amount, transaction ID, screenshot file, status (`pending`, `approved`, `rejected`), who decided, scan status, source (`online` or `admin`), note |
| `members` | Per registration: position (0 is the leader), name, roll, branch, phone |
| `students` | The uploaded list: roll, name, branch, phone, email |
| `organisers` | Username, salt, scrypt hash. The owner account is not here; it lives in `.env` |
| `settings`, `admin_sessions`, `audit` | Admin panel settings as JSON, sessions, activity log |

## Rules that must hold

Enforcement

1. **Enforce on the server.** Browser checks are a convenience. Every rule lives in `src/`: team size,
   event capacity, one student one event, unique team name and transaction ID, captcha, upload limits,
   student list membership, email verification.
2. **One student, one event** by default (`allowMultiEvent` is off). A roll number may be in one live
   registration. Clash checks always filter on `status != 'rejected'`, which is how a rejection frees
   the slot, the roll numbers, the team name and the transaction ID.
3. **Order of checks in `/api/register`**: cheap validation, then a reused transaction ID (identical
   resubmission returns the original, anything else is refused), then clash checks, then the proof of
   a human (email token, or captcha), and only then the virus scan and image work. Do not move costly
   work ahead of the captcha or token.
4. **Admin edits follow the same clash rules as students.** An organiser may override team size and
   event capacity after confirming (`override: true`), never the one student per event rule. Every
   edit is written to the activity log with what changed.
5. **A rejected registration is final.** It cannot be reopened or edited.

Data protection

6. **Nothing is written to disk unencrypted in production.** Files go through `sealFile()` and are read
   with `openFile()`. The database is opened only in `src/db.js`.
7. **Uploads are never stored as received.** Screenshots go through `scanOrThrow` then `sanitiseImage`
   (a re-encoded JPEG). Statements and student lists are scanned and parsed in memory only.
8. **The public roll number lookup returns masked names and emails** (`maskName`, `maskEmail`). Full
   values go to signed in admins only. With the student list on, the server ignores names, branch and
   the leader's email sent by the browser and uses the list.
9. **No real personal data** in code, tests, fixtures, commits, issues or screenshots.
10. **Secrets live in `.env` only.** Never commit it, print its values, or copy them into docs or tests.

Web safety

11. **Content Security Policy is strict**: `default-src 'self'`, no inline `<script>`, no inline
    `style=""` attributes, no CDN. Build DOM with `UI.el()`; set styles through classes or
    `element.style.x = ...` from script.
12. **User text goes through `textContent`** (which `UI.el()` does). Do not use `innerHTML`.
13. **SQL always uses `?` placeholders.**
14. **Admin writes need the session cookie and the `X-CSRF-Token` header.** `UI.api()` adds it.
    Downloads go through `UI.download()`, not `window.location`.
15. **Account management is owner only** (`requireOwner`). Organisers can do everything else.
16. **Test hooks** (`CAPTCHA_TEST_CODE`, `MAIL_TEST_FILE`) must stay disabled when `NODE_ENV=production`.

Keeping things in step

17. **A new setting goes in four places**: the code, `docker-compose.yml`, `.env.example` and
    `docs/configuration.md`. `scripts/check-config.mjs` fails the tests otherwise.
18. **Schema changes** go through `addColumn()` in `src/db.js`, so existing databases upgrade on start.
19. **Behaviour changes update the docs** in the same change: `docs/admin-guide.md` for anything an
    organiser sees, `docs/student-guide.md` for the public form, `docs/api.md` for endpoints, and
    `public/privacy.html` when what is collected or how it is stored changes.

## Conventions

- ES modules, Node 22.13 or newer, two space indent, single quotes, semicolons.
- Plain functions and prepared statements; no ORM, no framework on the client.
- Error responses are JSON: `{ "error": "message for a person", "fields": { "inputId": "message" } }`.
  Field keys match input ids in the page (`teamName`, `m0-roll`, `utr`, `captcha`), which is how the
  form puts the message under the right input. The admin team editor prefixes the ids with `ed-`.
- A choice the organiser may knowingly accept is answered with `409 { needsOverride: true }`; the page
  asks, then sends the same body again with `override: true`.
- Messages are written for the person reading them: what went wrong, then what to do.
- Text style: plain hyphens only (no en dashes), and avoid emojis. This applies to code, docs and UI text.
- Commit messages: one short line saying what the change does, a blank line, then details if needed.

## Testing a change

- `npm test` must pass. It runs the settings check, the API suite and the encryption suite.
- For a new rule or endpoint, add a line to `scripts/smoke-test.sh`:
  `check "name" 'expected substring' "$(request)"`.

| Helper | Does |
| --- | --- |
| `post PATH JSON` | A public POST |
| `team EVENT NAME ROLLPREFIX UTR COUNT` | A registration body with `COUNT` members |
| `reg BODY [ANSWER]` | Registers with a solved captcha |
| `precheck EVENT TEAM ROLLS` | The pre-payment check |
| `admin METHOD PATH [JSON]` | An admin call as the owner, with cookie and CSRF token |
| `org METHOD PATH [JSON]` | The same as an organiser account |
| `mm NAME ROLL [PHONE]`, `mteam NAME MEMBERS [STATUS] [UTR] [OVERRIDE]` | Bodies for the admin team endpoints |
| `setjson BODY KEY VALUE ...`, `send` | Change fields of a JSON body through files, then submit it |

- The suite runs in order against one database, so later checks depend on earlier ones. Read the
  neighbouring lines, and note that changing how many registrations exist can shift the count checks
  near the end (`overview`).
- There are no automated browser tests in the repository. For a page change, run the site, open it at
  about 360 px and 1280 px wide, click through the flow, and watch the console for errors.
  If you script a browser, wait for the smooth scroll between steps to finish before clicking.

## Deployment facts

- The site listens on `127.0.0.1:8094` on the OSSC server; the Cloudflare tunnel connects there.
  nginx trusts `CF-Connecting-IP` only from local and private addresses, which is why the port must
  stay bound to localhost.
- Email goes through `mail.webuildnow.in` (port 587 on the server, 1587 through a `cloudflared` tunnel
  on a laptop). The sender must be a `webuildnow.in` address.
- `DATA_KEY` cannot be recovered. Never regenerate or change it on a machine that already has data,
  except through `DATA_KEY_OLD` as described in `docs/operations.md`.
- Never run `docker compose down -v` on a machine with real data; it deletes the database.
- Images and CI actions are pinned to digests; Dependabot opens update pull requests. Do not merge a
  major runtime or driver upgrade close to the event without running the full tests and a manual pass.

## Things that are easy to get wrong

- `better-sqlite3` cannot bind `undefined` or booleans. Pass `null`, and `1` or `0`.
- Dependency install scripts are off (`.npmrc`). A native module must ship prebuilt binaries, including
  for Alpine (musl), or the Docker build fails.
- `express.json()` is applied per route with its own size limit. A new route that reads a body needs
  one (the admin router has a default of 100 kb).
- Rate limits are per address and a whole campus can share one. Keep limits generous for students and
  strict for admin sign in and email sending.
- The app runs with a read only filesystem as an unprivileged user. Write only under `DATA_DIR`, and
  never copy files into the data volume with `docker cp` alone (they become root owned); use
  `scripts/restore.sh`.
- `registrationState()` reports closed when no UPI ID is set. Tests set `UPI_ID`.
- Sharp renders SVG without fonts in the container, which is why the captcha draws digits as strokes.
- The mail library does its own DNS lookup and ignores `/etc/hosts`. `src/mailer.js` resolves the name
  itself and passes `servername` for TLS; keep that when touching the transport.
- Hand added registrations have an empty `screenshot` and may have an empty `utr`. Code that reads
  either must cope with that.
- Names in a registration are a copy. Editing a student updates the copies in live registrations;
  keep that propagation when changing `PUT /students/:roll`.
- Removing a row in the admin team editor can fire a late `change` event for a row that is gone.
  Handlers there must check that the row still exists.
