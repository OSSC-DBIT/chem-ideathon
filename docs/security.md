# Security

What the site protects, how, and what it does not protect. To report a problem, see
[SECURITY.md](../SECURITY.md) in the repository root.

## What is stored

| Data | Where | Encrypted on disk |
| --- | --- | --- |
| Registrations: team name, members' names, roll numbers, branch, section, leader's phone and email, transaction ID, status | Database | Yes |
| Student list: roll number, name, branch, section, phone, email | Database | Yes |
| Organiser accounts: username and password hash | Database | Yes |
| Settings, events, activity log, admin sessions | Database | Yes |
| Payment screenshots | Files in `uploads/` | Yes |
| Bank statements and student list files as uploaded | Never stored; read in memory | Not applicable |
| Verification codes, captcha answers | Memory only; gone on restart | Not applicable |

## Encryption at rest

One secret, `DATA_KEY`, protects everything on disk.

- **Database**: the whole SQLite file is encrypted with SQLCipher (AES-256) by the database driver
  (`better-sqlite3-multiple-ciphers`). This covers every table, the indexes and the write-ahead log.
- **Screenshots**: each file is encrypted with AES-256-GCM, with a fresh random 96 bit nonce per file
  and an authentication tag, so a file that was altered on disk is detected and refused.
- **Key derivation**: two separate 256 bit keys are derived from `DATA_KEY` with scrypt, one for the
  database and one for files, so one key is never used by two ciphers.
- **Start-up**: a database or screenshot from before encryption was switched on is converted
  automatically. With a wrong or missing key the app refuses to start and changes nothing.
- **In production the key is mandatory.** The app does not start without a `DATA_KEY` of at least
  32 characters.

What this protects against:

- A copied or stolen data volume, backup or disk. Without the key the files are unreadable.
- Backups being readable: `scripts/backup.sh` copies the files as they are on disk, encrypted.

What it does **not** protect against:

- Someone with root on the running server. They can read `.env` (which holds the key) or the app's
  memory. Encryption at rest protects stored copies, not a live machine that has been taken over.
- Exports. A CSV or Excel file downloaded from the admin panel is plain; whoever has that file can read it.
- Data in transit, which is the job of HTTPS (Cloudflare) and of TLS to the mail server.

Losing `DATA_KEY` means losing the data. See [Operations](operations.md#the-encryption-key).

## Who can register, and as whom

| Check | Stops |
| --- | --- |
| Student list | Roll numbers that are not 1st year students. Names and branch come from the list, never from the form. |
| Email code to the address on the list | Registering as another student. Only someone who can read that student's inbox gets the code. |
| One student, one event | The same student in two teams or two events |
| Unique transaction ID | One payment used for two registrations |
| Captcha before a code is sent, or before submit when email verification is off | Scripts flooding the form or other people's inboxes |
| Admin approval against the bank statement | Fake or unpaid registrations being confirmed |

Only the **team leader** is verified. Members are added by roll number without their own code, by
design: the verified leader is accountable for the team, and an organiser can reject an entry.

## Admin panel

- **Passwords**: the owner password lives only in `.env` and is compared through scrypt in constant
  time. Organiser passwords are stored as scrypt hashes with a per account salt. The minimum length is
  12 characters.
- **Sessions**: a random 256 bit token in an `HttpOnly`, `SameSite=Strict` cookie (and `Secure` over
  HTTPS). Only a hash of the token is stored. Sessions expire after 8 hours and are revoked on sign
  out, on account removal, and on a password change.
- **CSRF**: every change needs a per session token in the `X-CSRF-Token` header, and all writes are
  checked for same origin.
- **Sign in throttling**: 8 failures per 15 minutes per address in the app, and 10 requests a minute
  in nginx. The reply takes the same time whether or not the username exists.
- **Roles**: only the owner can add or remove organisers.
- **Activity log**: sign ins, failed sign ins with the address, approvals, rejections, deletions,
  exports, imports, blocked uploads, account and settings changes.

## Uploads

| Step | Payment screenshot | Bank statement, student list |
| --- | --- | --- |
| Type check | JPG, PNG or WebP by file signature, not by name | xlsx by signature, or text |
| Size limit | 10 MB in the browser, `MAX_SCREENSHOT_MB` (3) on the server | `MAX_STATEMENT_MB` (5) |
| Pixel limits | 200 to 10000 px per side, 40 megapixels | Not applicable |
| Virus scan | ClamAV, on the bytes exactly as received | ClamAV, before parsing |
| Cleaning | Fully decoded and re-saved as a new JPEG: metadata and hidden content are dropped | Parsed in memory, never written to disk |
| Storage | Encrypted, random file name, outside the web root | Not stored |
| Access | Signed in admins only | Not applicable |

## The web layer

- **Content Security Policy**: `default-src 'self'`, no inline scripts or styles, no third party
  resources. Fonts and images are served by the site itself.
- **Other headers**: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, a strict referrer
  policy, a permissions policy that disables camera, microphone, location and payment APIs, and HSTS
  when the request arrived over HTTPS.
- **Output**: text that people typed is inserted with `textContent`, never as HTML.
- **Database**: every query uses placeholders.
- **Exports**: cells that start with `=`, `+`, `-` or `@` are neutralised, so a spreadsheet does not
  run them as formulas.
- **Emails**: all values are escaped in the HTML version; addresses are validated and cannot contain
  line breaks.

## Privacy by design

- The public roll number lookup returns **masked** names and emails (`As** Ra*`, `as***@example.com`),
  so the form cannot be used to download the student list.
- Status lookup needs both the registration ID and the leader's phone number.
- Registration IDs are random, not sequential.
- Visitor addresses are used in memory for rate limiting and are not stored with registrations.
- No analytics, advertising or third party scripts.

## Abuse and rate limiting

Limits apply per visitor address, in nginx and again in the app. Behind the Cloudflare tunnel the
address is taken from `CF-Connecting-IP`, which is trusted only from local and private addresses;
that is why the port is published on `127.0.0.1` only.

Verification emails are limited by address too: one every 60 seconds, 3 resends per request, 6 per
hour and 12 per day per email address, plus a daily cap for the whole site.

## Deployment hardening

- The app and nginx containers run as non root, with a read only filesystem, no Linux capabilities
  and no privilege escalation.
- Only nginx is published, on localhost. The app and the virus scanner are on an internal network.
- Docker images and CI actions are pinned to exact digests. Dependabot proposes updates.
- Dependency install scripts are disabled (`.npmrc`), so a package cannot run code at install time.
- GitHub secret scanning with push protection, Dependabot alerts and private vulnerability reporting
  are switched on for the repository.
- CI runs the API tests, the encryption tests, a dependency audit and a Docker build on every push
  and pull request.

## Known limits and accepted risks

| Risk | Why it is accepted, and what limits it |
| --- | --- |
| Root on the server can read everything | Outside what an application can prevent. Keep the server patched and access limited. |
| Only the team leader is verified | A leader can add another student's roll number without asking. It is traceable to a verified leader, and an organiser can reject it. |
| A roll number can be probed for "is this student registered, and for which event" | Needed so teams learn about a clash before paying. Names stay masked. |
| The image captcha stops casual scripts, not image recognition tools | Rate limits and the email code are the real barrier. |
| Blind users cannot solve an image captcha | The form tells them to contact the coordinator. |
| Exports are plain files | They are needed for attendance sheets. Each export is logged with the account that made it. |
| Verification codes and captchas are lost on restart | Students ask for a new one. |
| A student without an email on the list is verified at the email they type | That proves the inbox works, not that they own the roll number. The admin panel shows how many students have no email. |
| One owner password in `.env` | Use organiser accounts for people; keep the owner password for setup. |
| The mail provider sees the leader's email address and the message | Needed to deliver email. The OSSC mail server is on the same machine. |

## Checklist before going live

- [ ] `DATA_KEY` is set, and a copy is stored somewhere other than the server
- [ ] `ADMIN_PASSWORD` is long and known to as few people as possible
- [ ] `.env` is readable only by its owner (`chmod 600 .env`)
- [ ] The site is reached over HTTPS, and `HOST_BIND` is left at `127.0.0.1`
- [ ] The student list is uploaded and both checks are on
- [ ] Each organiser has their own account
- [ ] A backup has been taken and a restore has been tried once
- [ ] The Overview tab shows no warnings
