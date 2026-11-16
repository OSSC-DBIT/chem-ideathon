# AGENTS.md

Guidance for AI coding agents (and a fast orientation for humans) working in this repository.

## What this is

The registration site for Ideathon '26, a one day event of the Department of Chemistry at Don Bosco
Institute of Technology, run for 1st year students. Team leaders register a team for an event, pay by
UPI, and organisers verify the payment in an admin panel. It is deployed with Docker Compose on a
college server and maintained by OSSC.

## Commands

| Task | Command |
| --- | --- |
| Install | `npm install` |
| Run for development | `ADMIN_PASSWORD=dev-password UPI_ID=test@upi CAPTCHA_TEST_CODE=24680 npm run dev` |
| Run the tests | `npm test` (bash and curl needed; about a minute) |
| Syntax check one file | `node --check src/public-routes.js` |
| Full stack | `docker compose up -d --build` (site on port 8080) |

There is no build step, no bundler, no TypeScript and no linter. The browser runs the files in
`public/` as they are.

## Layout

```
server.js               Express app: headers, routers, static files, error handler
src/db.js               SQLite (node:sqlite) schema, settings store, migrations, event seed
src/security.js         Admin login, sessions, CSRF, security headers, rate limiter
src/public-routes.js    /api/public, /qr, /captcha, /precheck, /verify/*, /register, /status
src/admin-routes.js     /api/admin/*: registrations, exports, statement matching, events, students, settings
src/uploads.js          Upload limits, image re-encoding (sharp), ClamAV scan
src/captcha.js          Self hosted image captcha
src/roster.js           Student list import (xlsx, csv) and lookup
src/mailer.js           SMTP sending and email templates
src/verify.js           Email verification codes and tokens
src/reconcile.js        Bank statement parsing and matching
src/export.js           CSV and Excel export
public/index.html       Public page; js/site.js is its script
public/admin.html       Admin panel; js/admin.js is its script
public/js/ui.js         Shared helpers: el(), api(), toast, dialogs
public/css/app.css      All styles (neobrutalist design tokens at the top)
scripts/smoke-test.sh   End to end API tests
nginx/default.conf      Reverse proxy and rate limits
```

## Rules that must hold

1. **Enforce on the server.** Browser checks are a convenience. Every rule lives in `src/`:
   team size, event capacity, one student one event, unique transaction ID, captcha, upload limits,
   student list membership, email verification.
2. **Content Security Policy is strict**: `default-src 'self'`, no inline `<script>`, no inline
   `style=""` attributes, no CDN. Build DOM with `UI.el()`; set styles through classes or
   `element.style.x = ...` from script.
3. **User text goes through `textContent`** (which `UI.el()` does). Do not use `innerHTML`.
4. **SQL always uses `?` placeholders.**
5. **Admin writes need the session cookie and the `X-CSRF-Token` header.** `UI.api()` adds it.
6. **Uploads**: never store bytes as received. Screenshots go through `scanOrThrow` then
   `sanitiseImage` (re-encoded JPEG). Statements and student lists are scanned and parsed in memory.
7. **Test hooks** (`CAPTCHA_TEST_CODE`, `MAIL_TEST_FILE`) must stay disabled when
   `NODE_ENV=production`.
8. **Schema changes** go through `addColumn()` in `src/db.js` so existing databases upgrade on start.
9. **Rejected registrations free their slot, roll numbers and transaction ID.** Queries that check
   for clashes filter on `status != 'rejected'`.
10. **No real personal data** in code, tests, fixtures, commits or screenshots.

## Conventions

- ES modules, Node 22.13+, two space indent, single quotes, semicolons.
- Plain functions and prepared statements; no ORM, no framework on the client.
- Error responses are JSON: `{ "error": "message for a person", "fields": { "inputId": "message" } }`.
  Field keys match input ids in the page (`teamName`, `m0-roll`, `utr`, `captcha`), which is how the
  form puts the message under the right input.
- Messages are written for students: what went wrong, then what to do.
- Text style: plain hyphens only (no en dashes), and avoid emojis.
- When a registration is replayed (same transaction ID, event, leader and size) the server returns
  the original instead of an error. Keep that property when touching `/api/register`.

## Testing a change

- Add a `check "name" 'expected substring' "$(request)"` line to `scripts/smoke-test.sh`. Use the
  helpers there: `post`, `reg` (registers with a solved captcha), `admin METHOD /path 'json'`,
  `team eventId name rollPrefix utr count`.
- The suite runs against a throwaway database, so tests may depend on earlier ones. Read the
  neighbouring checks before inserting a new one.
- For page changes, load the page at about 360 px and 1280 px wide and click through the flow.

## Things that are easy to get wrong

- `express.json()` is applied per route with its own size limit. A new route that reads a body needs
  one (the admin router has a default of 100 kb).
- Rate limits are per IP and a whole campus can share one IP. Keep limits generous for students and
  strict for admin login and email sending.
- The app runs with a read only filesystem in Docker. Write only under `DATA_DIR`.
- `registrationState()` reports closed when no UPI ID is set. Tests set `UPI_ID`.
- Sharp renders SVG without fonts in the container, which is why the captcha draws digits as strokes.
