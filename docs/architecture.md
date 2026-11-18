# Architecture

How the pieces fit together. For rules to follow when changing the code, see [AGENTS.md](../AGENTS.md).

## Containers

```
                         Internet
                            |
                     Cloudflare (HTTPS)
                            |
              cloudflared on the server (tunnel)
                            |
                   127.0.0.1:8094  (only published port)
                            |
   +------------------------+--------------------------------------+
   |  Docker network "internal"                                    |
   |                                                               |
   |   nginx  ----------->  app (Node.js, Express)  ---->  clamav  |
   |   rate limits,         API, pages, admin,             virus   |
   |   real visitor IP,     encryption                     scanner |
   |   friendly errors          |                                  |
   |                            v                                  |
   |                     volume: /data                             |
   |                     ideathon.db (encrypted)                   |
   |                     uploads/    (encrypted)                   |
   +---------------------------------------------------------------+
                            |
                  mail.webuildnow.in:587  (mail server on the host)
```

| Container | Image | Role |
| --- | --- | --- |
| `nginx` | nginx-unprivileged | Reverse proxy. Rate limits per visitor, takes the visitor's address from `CF-Connecting-IP`, caps upload size, and answers with readable errors when the app is down. |
| `app` | Built from `Dockerfile` (Node.js 24 on Alpine) | Everything else: the pages, the API, the admin panel, the database and encryption. |
| `clamav` | clamav | Virus scanner, spoken to over TCP on the internal network. |

There is no separate database server. SQLite runs inside the app, in one encrypted file.

## The app

No framework on the browser side and no build step: the files in `public/` are served as they are.

```
server.js                 Express app: security headers, routers, static files, error handler
src/
  db.js                   Opens (and if needed converts) the encrypted database; schema; settings; migrations
  vault.js                Encryption keys from DATA_KEY; sealing and opening files
  security.js             Owner and organiser accounts, sessions, CSRF, headers, rate limiter
  public-routes.js        What students use: info, QR, captcha, roll check, email code, register, status
  admin-routes.js         What organisers use: registrations, exports, statements, events, students, settings
  uploads.js              Upload limits, image re-encoding, virus scanning
  captcha.js              Self hosted image captcha
  roster.js               Student list import and lookup, name and email masking
  mailer.js               SMTP sending and the email templates
  verify.js               Email verification codes and tokens
  reconcile.js            Bank statement parsing and matching
  export.js               CSV and Excel export
public/
  index.html, js/site.js  The public page and its registration form
  admin.html, js/admin.js The admin panel
  js/ui.js                Shared helpers: DOM builder, API calls, toasts, dialogs
  css/app.css             All styles
  privacy.html            Privacy policy
```

Dependencies, six in total: `express` (web server), `better-sqlite3-multiple-ciphers` (encrypted
SQLite), `sharp` (images), `exceljs` (Excel read and write), `nodemailer` (email), `qrcode` (UPI QR).

## Data model

| Table | Holds | Notes |
| --- | --- | --- |
| `settings` | Key and JSON value pairs | Everything set in the admin panel |
| `events` | Title, description, team or solo, min and max size, limit, fee, open, order, archived | Removed events with registrations are archived, not deleted |
| `registrations` | Code, event, team name, leader email and phone, member count, amount, transaction ID, screenshot file name, status, reject reason, who decided and when, scan status | Status is `pending`, `approved` or `rejected` |
| `members` | Registration, position, name, roll number, branch, phone | Position 0 is the leader. Deleted with the registration. |
| `students` | Roll number, name, branch, phone, email | The uploaded student list |
| `organisers` | Username, salt, password hash, when and by whom created | The owner account is not here; it lives in `.env` |
| `admin_sessions` | Hash of the session token, CSRF token, username, expiry | |
| `audit` | Time, account, action, detail | The activity log |

Rules that the queries enforce:

- A clash check always ignores rejected registrations (`status != 'rejected'`). That is how a
  rejection frees the slot, the roll numbers, the team name and the transaction ID.
- Capacity counts pending and approved registrations.
- With "one student, one event" on, a roll number may appear in one live registration in total;
  otherwise in one per event.

New columns are added with `addColumn()` in `db.js`, which runs on every start, so an older database
upgrades itself.

## A registration, step by step

```
Browser                                   Server
-------                                   ------
load page             GET  /api/public    settings, events with slots left, which checks are on
type a roll number    POST /api/precheck  is it on the list (masked name back), already registered, team name free
Continue (team step)  POST /api/precheck  the same check for the whole team
                      GET  /api/captcha   image with five digits
send code             POST /api/verify/send    captcha checked, code emailed to the address on the list
enter code            POST /api/verify/check   right code returns a token, valid for an hour
payment step          GET  /api/qr        UPI QR for the exact amount
Submit                POST /api/register  see below
check status          POST /api/status    registration ID plus leader's phone
```

What `/api/register` does, in this order. Cheap checks come first, so that costly work only runs for
a submission that can succeed:

1. Registration window open, event exists and is open.
2. Field validation. With the student list on, names, branch and the leader's email are taken from
   the list; whatever the browser sent for them is ignored.
3. Transaction ID already registered? The identical registration gets its original answer back
   (safe retry); anything else is refused.
4. Clash check: capacity, team name, roll numbers.
5. Proof of a human: a valid email verification token for this leader and email, or a solved captcha
   when email verification is off.
6. Virus scan of the screenshot exactly as received.
7. Image decoded and re-encoded as a fresh JPEG.
8. Inside one database transaction: clash checks again, the encrypted screenshot is written, the
   registration and its members are inserted.
9. The token is used up, and a "registration received" email is sent in the background.

## Why some things are the way they are

| Choice | Reason |
| --- | --- |
| SQLite, not a database server | A few hundred registrations. One file is simple to run, back up and encrypt. |
| Whole file encryption, not per field | Search, uniqueness and joins keep working unchanged, and nothing is left out by mistake. |
| No browser framework | Small pages, no build step, and a strict Content Security Policy is easy to keep. |
| Captcha drawn from strokes | The container has no fonts, and no third party service is needed. |
| Names masked in the roll number lookup | The form must show something to confirm a teammate, without becoming a way to download the list. |
| Screenshots resized in the browser, then re-encoded on the server | Small uploads on mobile data, and the server never keeps a file as it was sent. |
| Verification codes kept in memory | Short lived by nature; losing them on restart only means asking again. |
| The site published on localhost | Only the Cloudflare tunnel connects, so the visitor address header can be trusted. |

## What is deliberately missing

- Online payment. Students pay by UPI and organisers verify against the bank statement.
- Editing a registration. A wrong one is rejected and made again, which keeps the payment check honest.
- Student accounts. A registration ID plus the leader's phone number is enough to check a status.
