# API reference

The pages talk to the server through a JSON API under `/api`. It is not a public API with stability
promises; it is documented for people working on the code.

## Conventions

- Requests with a body send `Content-Type: application/json`. Anything else gets `415`.
- Writes from another origin are refused with `403` (the `Origin` header must match the host).
- Errors look like this. `fields` maps an input id on the page to the message for that input.

```json
{ "error": "Some details need fixing. Check the highlighted fields.", "fields": { "m0-roll": "Enter a valid roll number." } }
```

| Status | Meaning |
| --- | --- |
| 400 | Something in the request needs fixing |
| 401 | Not signed in, or the session ended |
| 403 | Not allowed: registrations closed, wrong origin, bad CSRF token, or owner only |
| 404 | No such thing |
| 409 | A clash with existing data: roll number, team name, transaction ID, or event full |
| 413 | Upload too large |
| 415 | Not JSON |
| 422 | Upload blocked by the virus scanner |
| 429 | Too many requests; `Retry-After` says how long to wait |
| 502 | The mail server could not be reached |
| 503 | Admin or email not configured, scanner required but unavailable, or the app is restarting |
| 507 | The server is out of disk space |

## Public endpoints

### `GET /api/public`

Everything the page needs: event name and date, notice, branch list, contact, whether the student
list, email verification and multi event are on, the upload limit, the registration window
(`open`, `upcoming` or `closed`, with times), and the events with `taken` and `full`.

### `GET /api/qr?amount=250`

UPI QR code (PNG data URL), UPI link, UPI ID and payee for a whole number of rupees.

### `GET /api/captcha`

`{ "id", "image", "expiresInSeconds" }`. The image is a PNG data URL. A captcha works for one attempt
and five minutes.

### `POST /api/precheck`

Checks a team before payment. No captcha needed.

```json
{ "eventId": 1, "teamName": "Noble Gases", "rolls": ["26CH001", "26CH002"] }
```

- `200 { "ok": true, "students": [...] }` when nothing clashes.
- `409` with `fields` for a taken team name, a roll number already registered, a roll number not on
  the student list, or a full event.
- `students` is present when the student list is on: one entry per roll number, `null` for unknown
  ones, otherwise `{ "name": "As** Ra*", "branch": "CSE" }`. The first entry may carry a masked `email`.

### `POST /api/verify/send`

Emails a verification code to the team leader.

```json
{ "roll": "26CH001", "email": "typed@example.com", "captchaId": "...", "captchaAnswer": "24680" }
```

The email on the student list is used when there is one; `email` is used otherwise. A captcha is
needed to start; a resend of a code that is still valid does not need one.
Returns `{ "sentTo", "resendIn", "expiresIn", "resendsLeft" }`.

### `POST /api/verify/check`

`{ "roll", "email", "code" }` returns `{ "token", "validFor" }`. The token goes into the
registration as `verifyToken`. Five wrong codes cancel the code.

### `POST /api/register`

```json
{
  "eventId": 1,
  "teamName": "Noble Gases",
  "email": "leader@example.com",
  "members": [
    { "name": "Asha Rao", "roll": "26CH001", "branch": "CSE", "phone": "9876500001" },
    { "name": "Vikram N", "roll": "26CH002", "branch": "ECE", "phone": "" }
  ],
  "utr": "123456789012",
  "screenshot": "data:image/jpeg;base64,...",
  "consentPrivacy": true,
  "consentFirstYear": true,
  "verifyToken": "...",
  "captchaId": "...", "captchaAnswer": "24680"
}
```

- The first member is the leader and must have a phone number.
- With the student list on, `name`, `branch` and the leader's `email` are ignored and taken from the list.
- Send `verifyToken` when email verification is on, otherwise `captchaId` and `captchaAnswer`.
- `201` with `{ "code", "eventTitle", "teamName", "teamBased", "memberCount", "amount", "status" }`.
- `200` with the same shape when the identical registration was already accepted (safe retry).

### `POST /api/status`

`{ "code": "IDT26-K7M2QX", "phone": "9876500001" }` returns the status, the reject reason if any, the
team, event, size, amount and time. `404` when the pair does not match.

### `GET /healthz`

`{ "ok": true }`. Used by Docker's health check.

## Admin endpoints

All under `/api/admin`. Everything except sign in needs the session cookie; every write also needs
the `X-CSRF-Token` header with the value returned at sign in.

### Session

| Method and path | Body | Notes |
| --- | --- | --- |
| `POST /login` | `{ username, password }` | Sets the cookie; returns `{ username, csrf, owner }` |
| `GET /me` | | `{ username, csrf, owner }`, or `401` |
| `POST /logout` | | Ends the session |
| `POST /password` | `{ current, next }` | Organisers only; changes their own password |

### Registrations

| Method and path | Notes |
| --- | --- |
| `GET /registrations?q=&event=&status=` | List with members |
| `GET /registrations/:id/screenshot` | The decrypted JPEG |
| `POST /registrations/:id/decision` | `{ status: "approved" \| "rejected" \| "pending", reason }`; a reason is required to reject |
| `POST /registrations` | Add a registration by hand. `{ eventId, teamName, leaderEmail, utr, note, status, members, override }`. No captcha, code or screenshot. |
| `PUT /registrations/:id` | Edit a team. `{ teamName, leaderEmail, utr, note, members, override }` replaces the member list; the first member is the leader. Returns `registration` and `amountBefore`. Not for rejected registrations. |
| `POST /registrations/bulk-approve` | `{ ids: [...] }` |
| `POST /registrations/bulk-reject` | `{ ids: [...], reason }` |
| `DELETE /registrations/:id` | Deletes it and its screenshot |
| `GET /export?format=csv\|xlsx\|json&layout=teams\|participants` | Same filters as the list |

For both `POST /registrations` and `PUT /registrations/:id`: a team size outside the event's range, or a
full event, answers `409 { needsOverride: true }`; send the same body again with `override: true` to
accept it. A roll number that is already in another team is always refused.

### Bank statement

`POST /reconcile` with `{ kind: "text" \| "xlsx", content }` (`content` is the text, or the xlsx file
in base64). Returns one result per pending registration: `found`, `amountOk`, and the matching
statement `line`. Nothing is approved by this call.

### Events

`GET /events`, `POST /events`, `PUT /events/:id`, `DELETE /events/:id`. Body:
`{ title, description, teamBased, minMembers, maxMembers, maxTeams, fee, isOpen, sort }`.

### Student list and email

| Method and path | Notes |
| --- | --- |
| `GET /students?q=` | Counts, the three switches, mail status, and up to 200 students |
| `POST /students/import` | `{ kind, content, mode: "replace" \| "merge" }`; returns `imported`, `skipped`, `problems` |
| `POST /students` | Adds one student: `{ roll, name, branch, phone, email }` |
| `PUT /students/:roll` | Edits one student. Also updates the name and branch in their registrations; returns `registrationsUpdated`. |
| `POST /students/lookup` | `{ rolls: [...] }` returns full details for each roll number (or `null`), for the team editor |
| `DELETE /students/:roll` | Removes one student |
| `DELETE /students` | Clears the list and switches the list check off |
| `POST /mail/check` | Signs in to the mail server, sends nothing |
| `POST /mail/test` | `{ to }` sends one test email |

### Accounts (owner only for writes)

| Method and path | Notes |
| --- | --- |
| `GET /organisers` | Who has access |
| `POST /organisers` | `{ username, password }` |
| `DELETE /organisers/:username` | Removes the account and its sessions |

### Settings, overview, log

| Method and path | Notes |
| --- | --- |
| `GET /settings`, `PUT /settings` | Any subset of: `regMode`, `opensAt`, `closesAt`, `upiId`, `upiName`, `eventName`, `eventDate`, `venue`, `notice`, `contactName`, `contactPhone`, `allowMultiEvent`, `branches`, `rosterRequired`, `matchLeaderPhone`, `emailVerification` |
| `GET /overview` | Totals, event fill, scanner and encryption state, student list summary |
| `GET /audit` | The last 300 activity log entries |
